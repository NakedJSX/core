import path from 'node:path';

import { AsyncLocalStorage } from 'node:async_hooks';

import { getCurrentJob } from '../../build-system/nakedjsx.mjs';
import { finaliseCssClasses } from '../../build-system/css.mjs';
import { ServerDocument } from './document.mjs';
import { convertToAlphaNum } from '../../build-system/util.mjs';

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

/** Injected by the JSX compiler as needed */
export function __nakedjsx__createFragment(props)
{
    return props.children;
}

/** Injected by the JSX compiler as needed */
export function __nakedjsx__createElement(tag, props, ...children)
{
    if (children)
        children =
            children
                //
                // When JSX children are placed like <parent>{children}<child></parent>
                // We end up with [[...chidren],child] which we need to flatten.
                //
                .flat()
                // <p>{false && ...}<\/p> will result in an undefined child
                .filter(child => child !== undefined);

    if (tag === __nakedjsx__createFragment)
        return children;

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
    
    props = props ?? {};
    props.context = makeContext();

    if (children)
        for (const child of children)
            if (child instanceof DeferredElement)
                child.context._setParent(props.context);
    
    return new DeferredElement(props.context, createElement.bind(null, tag, props, children));
}

function createElement(tag, props, children)
{
    if (typeof tag === "function")
    {
        // Make child elements selectively placeable via {props.children}
        props.children = children;

        const deferredRender = tag(props);
        connectContexts(props.context, deferredRender);
        return renderNow(deferredRender);
    }

    //
    // We're dealing with regular HTML, not a JSX component
    //

    const { document }  = asyncLocalStorage.getStore();
    const element       = document.createElement(tag, props.context);
    const eventHandlers = [];

    Object.entries(props).forEach(
        ([name, value]) =>
        {
            if (name.startsWith('on'))
                eventHandlers.push({ name, value});
            else if (name === 'className')
                element.setAttribute('class', value);
            else
                element.setAttribute(name, value);
        });
    
    //
    // Generate event handling JS
    //
    // It's done this way so that terser tree shaking
    // doesn't remove otherwise unused handlers in the client js,
    // and also that the function names can be mangled.
    //

    // It will need an id to hook up the handler
    if (eventHandlers.length)
        if (element.id === undefined)
            element.setAttribute('id', Page.UniqueId());

    for (const { name, value } of eventHandlers)
    {
        const onEvent = name.toLowerCase();
        Page.AppendJs(
`(()=>{
    var e = document.getElementById(${JSON.stringify(element.id)});
    e.${onEvent} = (function(event) { ${value} }).bind(e);
})()`
            );
    }

    children.forEach((child) => element.appendChild(renderNow(child)));

    return element;
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

function renderNow(deferredRender)
{
    if (Array.isArray(deferredRender))
        return deferredRender.flat().map(renderNow);
    else if (deferredRender instanceof DeferredElement)
        return deferredRender.impl();
    else if (deferredRender === undefined || deferredRender === null || deferredRender === false || deferredRender === true)
        return undefined;
    else if (typeof deferredRender == 'string')
        return deferredRender;
    else
        // Convert anything else, number etc, to a string
        return `${deferredRender}`
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
         * If it hasn't been added already, add JavaScript code to the page.
         * @param {function|string} js - JavaScript code to be added.
         * @param {object} [options] - Alter behavior of AppendJs()
         * @param {object} [options.allowDuplicate] - Set to true to allow adding code that's been added before on this page
         */
        AppendJs(js, { allowDuplicate } = {})
        {
            //
            // Convert any remaining function objects to string.
            // Hopefully they have been converted to strings by
            // the page page api babel plugin.
            //
            
            const jsString = `${js}`;

            const { thisBuild } = getCurrentJob().page;

            if (thisBuild.inlineJsSet.has(jsString))
            {
                //
                // We've already added this JS to the page
                // but add it anyway if duplicates are allowed.
                //

                if (allowDuplicate)
                    thisBuild.inlineJs.push(jsString);
            }
            else
            {
                //
                // Remember that we have added this JS, then add it.
                //

                thisBuild.inlineJsSet.add(jsString);
                thisBuild.inlineJs.push(jsString);
            }
        },

        /**
         * Add client JS that invokes function with the supplied arguments.
         * @param {string} functionName - name of function to invoke in client JS.
         */
        AppendJsCall(functionName, ...args)
        {
            if (typeof functionName !== 'string')
                throw Error(`Argument passed to AppendJsCall is not a string: ${functionName}`);
            
            functionName = functionName.trim();
            if (functionName === '')
                throw Error(`AppendJsCall functionName is empty`);

            this.AppendJs(`${functionName}(${args.map(arg => JSON.stringify(arg))})`, { allowDuplicate: true });
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
            const { page, commonCss, onRenderStart, onRendered, developmentMode } = getCurrentJob();

            if (outputFilename)
                outputFilename = path.join(path.dirname(page.htmlFile), outputFilename);
            else
                outputFilename = page.htmlFile;

            //
            // Let the build system know that this page is fully configured.
            // At this point we can expect any client JS to be compiled.
            //
            // NOTHING ASYNC CAN BE SAFELY INVOKED BEFORE onRenderStart()
            //

            await onRenderStart(outputFilename);

            //
            // We have our page structure, it's now time to process CSS attributes
            //

            // Equivalent to this.AppendHead(<style><raw-content content={finaliseCssClasses(__nakedjsx_get_document(), commonCss, page.thisBuild.scopedCssSet)}></raw-content></style>);
            const finalCss = finaliseCssClasses(getDocument(), commonCss, page.thisBuild.scopedCssSet);
            if (finalCss)
                this.AppendHead(
                    __nakedjsx__createElement(
                        'style',
                        null,
                        __nakedjsx__createElement(
                            'raw-content',
                            {
                                content: finalCss
                            })
                        )
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
                    __nakedjsx__createElement(
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
                    __nakedjsx__createElement(
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
                    __nakedjsx__createElement(
                        'script',
                        null,
                        __nakedjsx__createElement(
                            'raw-content',
                            {
                                content
                            })
                        )
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
            // Render the document to HTML and pass result back to the build thread.
            //

            onRendered(getDocument().toHtml({ relativeAssetRoot }));

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

        ////

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
        }
    };
    