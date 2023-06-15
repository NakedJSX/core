import path from 'node:path';

import { AsyncLocalStorage } from 'node:async_hooks';

import { getCurrentJob } from '../../build-system/nakedjsx.mjs';
import { finaliseCssClasses } from '../../build-system/css.mjs';
import { ServerDocument } from './document.mjs';
import { convertToAlphaNum, log, semicolonify } from '../../build-system/util.mjs';

const interBuildCache   = new Map();
const asyncLocalStorage = new AsyncLocalStorage();

export async function runWithPageAsyncLocalStorage(callback)
{
    //
    // Our simple static Page.* API is enabled by the
    // current document being stored in async local
    // storage. The entire dynamic import() of the
    // rolled up page generation file is via here.
    //

    await asyncLocalStorage.run(
        Object.preventExtensions(
            {
                document:   null,
                refs:       new Map()
            }),
        callback);
}

function setDocument(document)
{
    asyncLocalStorage.getStore().document = document;
}

function getDocument(document)
{
    return asyncLocalStorage.getStore().document;
}

function hasAddedClientJs(clientJs)
{
    const thisBuild = getCurrentJob().page.thisBuild;

    return thisBuild.inlineJsSet.has(clientJs);
}

function addClientJs(clientJs)
{
    const thisBuild = getCurrentJob().page.thisBuild;

    //
    // Add this JS and remember we did.
    //

    thisBuild.inlineJsSet.add(clientJs);
    thisBuild.inlineJs.push(clientJs);
}

/**
 * Async Ref class allowing refs to be safely shared by multiple async scopes.
 */
class Ref
{
    constructor()
    {
        //
        // Each async context gets a unique 'this' key in the refs map,
        // allowing a single instance of ref to be used by multiple
        // async contexts.
        //

        const { refs } = asyncLocalStorage.getStore();

        refs.set(this, {});
    }

    set(element)
    {
        const { refs } = asyncLocalStorage.getStore();
        
        refs.get(this).element = element;
    }

    appendJsx(jsx)
    {
        //
        // Set the parent context of jsx to the referenced element,
        // then render the jsx and append the result.
        //

        const { element } = asyncLocalStorage.getStore().refs.get(this);

        connectContexts(element.context, jsx);
        const rendered = renderNow(jsx);
        element.appendChild(rendered);
    }
}

/**
 * A callback that is passed the current page configuration.
 * @callback ConfigureCallback
 * @param {object} config
 */

export const Page =
    {
        /**
         * Alter the default config object for pages generated in this file.
         * Can be called between pages if needed.
         * @param {ConfigureCallback} callback - Called with the current config object for possible alteration.
         */
        Config(callback)
        {
            callback(getCurrentJob().page.thisBuild.config);
        },

        /**
         * Begin construction of a HTML document.
         * @param {string} lang - Will be placed in the 'lang' attribute of the html tag.
         */
        Create(lang)
        {
            getCurrentJob().page.thisBuild.onPageCreate();

            setDocument(new ServerDocument(lang));
        },

        /**
         * Append JSX to the head tag.
         * @param {*} child - JSX to be appended to the head tag.
         */
        AppendHead(child)
        {
            getDocument().head.appendChild(renderNow(child));
        },

        /**
         * Append CSS to the common CSS placed before extracted scoped CSS.
         * @param {*} css - CSS to be added.
         */
        AppendCss(css)
        {
            getCurrentJob().commonCss += css;
        },

        /**
         * Append JSX to the body tag.
         * @param {*} child - JSX to be appended to the body tag.
         */
        AppendBody(child)
        {
            getDocument().body.appendChild(renderNow(child));
        },

        /**
         * Add one or more JavaScript statement to the page. A statement can be actual Javascript code, or a string containing it.
         * @param {...object} jsCode - JavaScript code, or string containing it, to be added
         */
        AppendJs(...jsCode)
        {
            const resultingJs = jsCode.map(semicolonify).join('\n');
            
            addClientJs(resultingJs);
        },

        /**
         * If it hasn't been added already, add JavaScript code to the page.
         * @param {...object} jsCode - JavaScript code to be added. More than one arg is magically converted to one by a babel plugin.
         */
        AppendJsIfNew(...jsCode)
        {
            const resultingJs = jsCode.map(semicolonify).join('\n');

            if (hasAddedClientJs(resultingJs)) // already added this combination of js before
                return;
            
            addClientJs(resultingJs);
        },

        /**
         * Add client JS that invokes function with the supplied arguments.
         * @param {function|string} functionName - name of function to invoke in client JS.
         * @param {...object} args - zero or more arguments to evaluate at build time and pass the result to the function at client run time.
         */
        AppendJsCall(functionName, ...args)
        {
            if (typeof functionName === 'function')
                functionName = functionName.name;

            if (typeof functionName !== 'string')
                throw Error(`Argument passed to AppendJsCall is not a string or a named function: ${functionName}`);
            
            functionName = functionName.trim();
            if (functionName === '')
                throw Error(`AppendJsCall functionName is empty`);

            this.AppendJs(`${functionName}(${args.map(arg => JSON.stringify(arg))})`);
        },

        /**
         * Allocate an id unique to the page
         */
        UniqueId()
        {
            const { thisBuild } = getCurrentJob().page;

            return thisBuild.config.uniquePrefix + convertToAlphaNum(thisBuild.nextUniqueId++) + thisBuild.config.uniqueSuffix;
        },

        /**
         * EvaluateNow JSX immediately - useful for parents that want children to pass data up to them via context.
         * 
         * Normally, parents are evaluated before their children.
         * 
         * @param {*} jsx - JSX element, or array of, to be rendered
         */
        EvaluateNow(jsx)
        {
            const rendered = renderNow(jsx);
            return new DeferredElement(makeContext(), () => rendered);
        },

        /**
         * Create a Ref that can be passed to a JSX element to capture a reference to it.
         */
        RefCreate()
        {
            return new Ref();
        },

        /**
         * Render the HTML page and pass it back to the build process.
         * @param {string} [outputFilename] - Override the default name of the generated html file, relative to the default output dir.
         */
        async Render(outputFilename)
        {
            const { page, commonCss, onRenderStart, onRendered, developmentMode, templateEngineMode } = getCurrentJob();
            const document = getDocument();

            if (outputFilename)
            {
                if (templateEngineMode)
                    throw new Error(`Can't specify page filename in template engine mode.`);
                
                outputFilename = path.join(path.dirname(page.htmlFile), outputFilename);
            }
            else
                outputFilename = page.htmlFile;

            //
            // Let the build system know that this page is fully configured.
            // At this point we can expect any client JS to be compiled.
            //
            // NOTHING ASYNC CAN BE SAFELY INVOKED BEFORE onRenderStart()
            //

            await onRenderStart(page, outputFilename);

            //
            // We have our page structure, it's now time to process CSS attributes
            //

            // Equivalent to this.AppendHead(<style><raw-content content={finaliseCssClasses(__nakedjsx_get_document(), commonCss, page.thisBuild.scopedCssSet)}></raw-content></style>);
            const finalCss = finaliseCssClasses(commonCss, document.elementsWithCss, page.thisBuild.scopedCssSet);
            if (finalCss)
                this.AppendHead(
                    jsx(
                        'style',
                        {
                            children: jsx('raw-content', { content: finalCss })
                        })
                    );

            //
            // Generate <script> tags for javascript
            //

            if (developmentMode)
            {
                //
                // Inject the dev server client script that causes auto-fresh to work
                //

                // Equivalent to this.AppendHead(<script src="/nakedjsx:/client.js" async defer />);
                this.AppendHead(
                    jsx(
                        'script',
                        {
                            src: '/nakedjsx:/client.js',
                            async: true,
                            defer: true
                        })
                    );
            }

            for (const src of page.thisBuild.output.fileJs)
            {
                // Equivalent to this.AppendHead(<script src={src} async defer />);
                this.AppendHead(
                    jsx(
                        'script',
                        {
                            src,
                            async: true,
                            defer: true
                        })
                    );
            }

            for (const content of page.thisBuild.output.inlineJs)
            {
                // Equivalent to this.AppendBody(<script><raw-content content={content} /></script>);
                this.AppendBody(
                    jsx(
                        'script',
                        {
                            children: jsx('raw-content', { content })
                        })
                    );
            }

            //
            // Now that we can know the output path, we can calculate a relative path
            // back to the site root.
            //

            const fullOutputPath =
                path.normalize(
                    path.join(
                        page.outputRoot,
                        outputFilename
                        )
                    );

            const relativeAssetRoot =
                path.relative(
                    path.dirname(fullOutputPath),
                    page.outputAssetRoot);

            //
            // Render the document to HTML and pass result back
            //

            onRendered(document.toHtml({ relativeAssetRoot }));
            // onRendered('<html></html>');

            setDocument(null);
        },

        ////

        /**
         * Get the full path for a path relative to the output directory for this page
         */
        GetOutputPath(relativeOutputPath)
        {
            return path.join(getCurrentJob().page.outputDir, relativeOutputPath);
        },

        /**
         * Get the full uri path for a path relative to the output directory for this page
         */
        GetOutputUri(relativeOutputPath)
        {
            return getCurrentJob().page.uriPath + relativeOutputPath.split(path.sep).join('/');
        },

        ////

        Log(...args)
        {
            log(...args);
        },

        /**
         * Object a named Map that persists between builds, useful for tag content caching.
         * @param {*} name 
         */
        CacheMapGet(name)
        {
            let cache = interBuildCache.get(name);

            if (!cache)
            {
                cache = new Map();
                interBuildCache.set(name, cache);
            }

            return cache;
        },

        ////

        /**
         * Is this a development mode build?
         */
        IsDevelopmentMode()
        {
            return getCurrentJob().developmentMode;
        }
    };

/* This export is needed for JSX edge case that will probably never happen to a NakedJSX user: https://github.com/facebook/react/issues/20031#issuecomment-710346866*/
export function createElement(tag, props, ...children)
{
    if (children.length == 1)
    {
        props.children = children[0];
        return jsx(tag, props);
    }
    else if (children.length > 1)
    {
        props.children = children;
        return jsxs(tag, props);
    }
    else
        return jsx(tag, props);
}

export const Fragment = Symbol();

/** Injected by the JSX compiler for more than one child */
export function jsxs(tag, props)
{
    if (tag === Fragment)
        return props.children;

    //
    // Each element has a magical context prop that proxies
    // context data from parent elements (when attached).
    //
    // For this to be useful, parents JSX functions need to execute
    // before child tags - otherwise it would be too late
    // to provide context data to the child.
    //
    // The natural order of execution is depth first, so
    // we jump through a few hoops to change that.
    //
    
    props.context = makeContext();

    for (const child of props.children)
        if (child instanceof DeferredElement)
            child.context._setParent(props.context);
    
    return new DeferredElement(props.context, createElementImpl.bind(null, tag, props));
}

/** Injected by the JSX compiler for zero or one children */
export function jsx(tag, props)
{
    if (tag === Fragment)
        return props.children;

    //
    // See comment in jsxs() regarding contexts
    //
    
    props.context = makeContext();

    if (props.children instanceof DeferredElement)
        props.children.context._setParent(props.context);
    
    return new DeferredElement(props.context, createElementImpl.bind(null, tag, props));
}

function createElementImpl(tag, props)
{
    if (typeof tag === "function")
    {
        // Allow tag implementations to assume children is an array
        if (!Array.isArray(props.children))
            props.children = [props.children];

        const deferredRender = tag(props);
        connectContexts(props.context, deferredRender);
        return renderNow(deferredRender);
    }

    //
    // We're dealing with regular HTML, not a JSX component
    //

    const document      = getDocument();
    const element       = document.createElement(tag, props.context);
    const eventHandlers = [];

    for (const [name, value] of Object.entries(props))
    {
        if (!value)
            continue;
    
        // skip magic props
        if (name === 'children' || name === 'context')
            continue;
        
        if (name.startsWith('on'))
            eventHandlers.push({ name, value});
        else if (name === 'className')
            element.setAttribute('class', value);
        else
        {
            if (name === 'css')
                document.elementsWithCss.push(element);

            element.setAttribute(name, value);
        }
    }
    
    //
    // Generate event handling JS
    //
    // It's done this way so that terser tree shaking
    // doesn't remove otherwise unused handlers in the client js,
    // and also that the function names can be mangled.
    //

    if (eventHandlers.length)
    {
        // It will need an id to hook up the handler
        if (element.id === undefined)
            element.setAttribute('id', Page.UniqueId());

        let js = `  var e = document.getElementById(${JSON.stringify(element.id)});\n`;

        for (const { name, value } of eventHandlers)
        {
            const onEvent = name.toLowerCase();
            // wrap the code with a function that sets 'this' and 'event' to expected values
            js += `  e.${onEvent} = (function(event) { ${value} }).bind(e);\n`;
        }
        
        Page.AppendJs(`(()=>{\n${js}})()`);
    }

    if (Array.isArray(props.children))
    {
        for (const child of props.children)
            element.appendChild(renderNow(child));
    }
    else
        element.appendChild(renderNow(props.children));

    return element;
}

class DeferredElement
{
    context;
    impl;

    constructor(context, impl)
    {
        this.context    = context;
        this.impl       = impl;
    }
}

function renderNow(deferredRender)
{
    if (Array.isArray(deferredRender))
        return deferredRender.map(renderNow);
    else if (deferredRender instanceof DeferredElement)
        return deferredRender.impl();
    else if (deferredRender === undefined || deferredRender === null || deferredRender === false || deferredRender === true)
        return undefined;
    else if (typeof deferredRender === 'string')
        return deferredRender;
    else
        // Convert anything else, number etc, to a string
        return `${deferredRender}`
}

function makeContext()
{
    let parent;

    function _setParent(newParent)
    {
        parent = newParent;
    }
    
    const context =
        new Proxy(
            new Map(),
            {
                set(target, property, value)
                {
                    if (property.startsWith('_'))
                        throw Error('Cannot set context properties with keys starting with _');

                    target.set(property, value);

                    return true;
                },

                get(target, property)
                {
                    if (property === _setParent.name)
                        return _setParent.bind(null);

                    if (target.has(property))
                        return target.get(property);
                    
                    if (parent)
                        return parent[property];

                    return undefined;
                }
            });

    return context;
}

function connectContexts(parentContext, deferredRender)
{
    if (Array.isArray(deferredRender))
    {
        deferredRender.forEach(connectContexts.bind(null, parentContext));
        return;
    }
    else if (deferredRender instanceof DeferredElement)
    {
        if (deferredRender.context) // can be null if Page.EvaluateNow is used
            deferredRender.context._setParent(parentContext);

        return;
    }
}