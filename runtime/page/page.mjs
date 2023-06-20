import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

import * as _parser from "@babel/parser";
import _traverse from "@babel/traverse";
const babel =
    {
        parse:              _parser.parse,
        parseExpression:    _parser.parseExpression,
        traverse:           _traverse.default
    };

import { getCurrentJob } from '../../build-system/nakedjsx.mjs';
import { ServerDocument, CachingHtmlRenderer, Element } from './document.mjs';
import { convertToAlphaNum, log, semicolonify } from '../../build-system/util.mjs';
import { LruCache } from '../../build-system/cache.mjs';
import { loadCss } from '../../build-system/css.mjs';

const interBuildCache           = new Map();
const htmlEventHandlerCache     = new LruCache('unbound identifiers', 1024);
const asyncLocalStorage         = new AsyncLocalStorage();

// Generated 2023-06-17 in Chrome using: JSON.stringify(Object.keys(window).filter(key => key.startsWith('on')))
const validHtmlEventHandlers =
    new Set(
        ["onsearch","onappinstalled","onbeforeinstallprompt","onbeforexrselect","onabort","onbeforeinput","onblur","oncancel","oncanplay","oncanplaythrough","onchange","onclick","onclose","oncontextlost","oncontextmenu","oncontextrestored","oncuechange","ondblclick","ondrag","ondragend","ondragenter","ondragleave","ondragover","ondragstart","ondrop","ondurationchange","onemptied","onended","onerror","onfocus","onformdata","oninput","oninvalid","onkeydown","onkeypress","onkeyup","onload","onloadeddata","onloadedmetadata","onloadstart","onmousedown","onmouseenter","onmouseleave","onmousemove","onmouseout","onmouseover","onmouseup","onmousewheel","onpause","onplay","onplaying","onprogress","onratechange","onreset","onresize","onscroll","onsecuritypolicyviolation","onseeked","onseeking","onselect","onslotchange","onstalled","onsubmit","onsuspend","ontimeupdate","ontoggle","onvolumechange","onwaiting","onwebkitanimationend","onwebkitanimationiteration","onwebkitanimationstart","onwebkittransitionend","onwheel","onauxclick","ongotpointercapture","onlostpointercapture","onpointerdown","onpointermove","onpointerrawupdate","onpointerup","onpointercancel","onpointerover","onpointerout","onpointerenter","onpointerleave","onselectstart","onselectionchange","onanimationend","onanimationiteration","onanimationstart","ontransitionrun","ontransitionstart","ontransitionend","ontransitioncancel","onafterprint","onbeforeprint","onbeforeunload","onhashchange","onlanguagechange","onmessage","onmessageerror","onoffline","ononline","onpagehide","onpageshow","onpopstate","onrejectionhandled","onstorage","onunhandledrejection","onunload","ondevicemotion","ondeviceorientation","ondeviceorientationabsolute","onbeforematch","oncontentvisibilityautostatechange"]
        );

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
        callback)
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
    const { thisRender } = getCurrentJob().page;

    return thisRender.inlineJsSet.has(clientJs);
}

function addClientJs(clientJs)
{
    const { thisRender } = getCurrentJob().page;

    //
    // Add this JS and remember we did.
    //

    thisRender.inlineJsSet.add(clientJs);
    thisRender.inlineJs.push(clientJs);
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

        // Page.Memo is not yet ready as it does not yet deal with rendering side effects like scoped CSS classes.
        //
        // /**
        //  * In tempalte engine mode, caches the JSX output based on cacheKey. If cacheKey omitted, an attempt is made to generate one from all JavaScript identifiers used within the JSX.
        //  * @param {*} jsx - JSX to wrap in a cache
        //  * @param {*} cacheKey - 
        //  * @returns 
        //  */
        // Memo(jsx, cacheKey)
        // {
        //     // Calls to this function are replaced with generated code at build time.
        // },

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
            const { thisBuild, thisRender } = getCurrentJob().page;

            return thisBuild.config.uniquePrefix + convertToAlphaNum(thisRender.nextUniqueId++) + thisBuild.config.uniqueSuffix;
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
            return DeferredElement.From(makeContext(), () => rendered);
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

            const finalCss =
                loadCss(
                    commonCss + page.thisBuild.scopedCssSet.collateAll(),
                    {
                        renameVariables: true
                    });
            
            if (finalCss)
                // Equivalent to this.AppendHead(<style><raw-content content={finalCss} /></style>);
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

            for (const src of page.thisRender.output.fileJs)
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

            for (const content of page.thisRender.output.inlineJs)
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

/** WARNING: This internal API is subject to change without notice. */
export const __nakedjsx_page_internal__ =
    {
        getMemoCache(cacheId)
        {
            const memoCaches = getCurrentJob().page.thisBuild.cache.memo;
            let cache = memoCaches[cacheId];
            if (cache)
                return cache;
            
            cache               = new LruCache(cacheId);
            memoCaches[cacheId] = cache;

            return cache;
        },

        memoCacheGet(cacheId, key)
        {
            const memoCache = this.getMemoCache(cacheId);
            return memoCache.get(key);
        },

        memoCacheSet(cacheId, key, value)
        {
            const memoCache             = this.getMemoCache(cacheId);
            const cachingHtmlRenderer   = new CachingHtmlRenderer(renderNow(value));

            memoCache.set(key, cachingHtmlRenderer);

            return cachingHtmlRenderer;
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
    
    if (typeof tag === 'function')
        return DeferredElement.From(props.context, tagImpl.bind(null, tag, props));
    else
        return DeferredElement.From(props.context, createElementImpl.bind(null, tag, props));
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
    
    if (typeof tag === 'function')
        return DeferredElement.From(props.context, tagImpl.bind(null, tag, props));
    else
        return DeferredElement.From(props.context, createElementImpl.bind(null, tag, props));
}

function processHtmlEventHandler(code)
{
    const cachedResult = htmlEventHandlerCache.get(code);
    if (cachedResult)
        return cachedResult;

    const result =
        {
            unboundIdentifiers: new Set(),
            hasJsx: false
        }

    const ast = babel.parse(code, { plugins: ['jsx'] });
    babel.traverse(
        ast,
        {
            // enter(nodePath)
            // {
            //     console.log(nodePath.node.type);
            // },

            JSX(nodePath)
            {
                result.hasJsx = true;
            },

            Identifier(nodePath)
            {
                const binding = nodePath.scope.getBinding(nodePath.node.name);

                if (!binding)
                    result.unboundIdentifiers.add(nodePath.node.name);
            }
        });

    return htmlEventHandlerCache.set(code, result);
}

function tagImpl(tag, props)
{
    // Allow tag implementations to assume children is an array
    if (!Array.isArray(props.children))
        props.children = [props.children];

    const deferredRender = tag(props);
    connectContexts(props.context, deferredRender);
    return renderNow(deferredRender);
}

function createElementImpl(tag, props)
{
    //
    // We're dealing with a regular HTML element, not a JSX function
    //

    const { scopedCssSet } = getCurrentJob().page.thisBuild;

    const element       = Element.From(tag, props.context);
    const cssClasses    = new Set();

    for (const [name, value] of Object.entries(props))
    {
        if (!value)
            continue;

        // skip magic props
        if (name === 'children' || name === 'context')
            continue;

        const nameLowercase = name.toLowerCase();
        
        if (validHtmlEventHandlers.has(nameLowercase))
        {
            const { unboundIdentifiers, hasJsx } = processHtmlEventHandler(value);

            //
            // TODO: consider deduplicating identical handlers
            //

            if (hasJsx)
            {
                //
                // If the event handler contains JSX, we need to
                // move the implementation to the client JS
                // where the JSX will be compiled. This involves
                // generating a unique function name and ensuring
                // that it isn't treeshaken away.
                //

                const identifier = `__nakedjsx_event_handler${Page.UniqueId()}`;
                Page.AppendJs(`window.${identifier} = function(event) { ${value} }`);
                element.setAttribute(name, `${identifier}.call(this, event)`);
            }
            else
            {
                //
                // With no JSX in use, it's smaller to leave the
                // event handler where it is.
                //
                // Each unbound identifier in an event handler must
                // be a reference to global scope JS (or a bug).
                //
                // If it's a reference to something in client JS,
                // we need to make sure that it's not tree shaken
                // out of the final bundle (it might be the only
                // reference).
                //
                // This approach prevents compressing of the name.
                // IDEALLY we'd use the ability of terser to not
                // remove specified unused identifiers, compress the
                // name, and then update all event handler source
                // that references the identifier. A lot of
                // complexity for a small compression gain though.
                //

                for (const identifier of unboundIdentifiers)
                    Page.AppendJsIfNew(`window.${identifier} = ${identifier};`);

                element.setAttribute(nameLowercase, value);
            }
        }
        else if (name === 'className')
            for (const className of value.split(/[\s]+/))
                cssClasses.add(className);
        else if (name === 'css')
            cssClasses.add(scopedCssSet.getClassName(value));
        else
            element.setAttribute(name, value);
    }

    if (cssClasses.size)
        element.setAttribute('class', Array.from(cssClasses).join(' '));

    if (Array.isArray(props.children))
    {
        for (const child of props.children)
            element.appendChild(renderNow(child));
    }
    else if (props.children)
        element.appendChild(renderNow(props.children));

    return element;
}

class DeferredElement
{
    static #pool = [];

    context;
    deferredRender;

    static From(context, deferredRender)
    {
        if (this.#pool.length)
        {
            const de = this.#pool.pop();

            de.context         = context;
            de.deferredRender  = deferredRender;

            return de;
        }

        return new DeferredElement(context, deferredRender);
    }

    constructor(context, deferredRender)
    {
        this.context        = context;
        this.deferredRender = deferredRender;
    }

    release()
    {
        DeferredElement.#pool.push(this);
    }
}

function renderNow(deferredRender)
{
    if (Array.isArray(deferredRender))
        return deferredRender.map(renderNow)
    else if (deferredRender instanceof DeferredElement)
    {
        const result = deferredRender.deferredRender();
        deferredRender.release();
        return result;
    }
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