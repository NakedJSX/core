import path from 'node:path';

import { AsyncLocalStorage } from 'node:async_hooks';

import { getCurrentJob } from '../../build-system/nakedjsx.mjs';
import { finaliseCssClasses } from '../../build-system/css.mjs';
import { ServerDocument } from './document.mjs';

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
    // For this to be useful, parents JSX tags need to execute
    // before child tags - otherwise it would be too late
    // to provide context data to the child.
    //
    // The natural order of execution is depth first, so
    // we jump through a few hoops to change that.
    //

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
    
    props = props ?? {};
    
    props.context = context;

    if (children)
        for (const child of children)
            if (child instanceof DeferredElement)
                child.context._setParent(context);
    
    return new DeferredElement(context, createElement.bind(null, tag, props, children));
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

    Object.entries(props).forEach(
        ([name, value]) =>
        {
            if (typeof window !== 'undefined' && name.startsWith('on') && name.toLowerCase() in window)
                element.addEventListener(name.toLowerCase().substring(2), value);
            else if (name === 'className')
                element.setAttribute('class', value);
            else
                element.setAttribute(name, value);
        });

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
    else if (typeof deferredRender === 'string')
        return deferredRender;
    else if (deferredRender === undefined || deferredRender === false)
        return undefined;
    else
        throw Error('Unexpected type passed to renderNow: ' + typeof deferredRender);
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

export const Page =
    {
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
         * Append JavaScript code to the page, optionally replacing any previously appended JavaScript with the same key.
         * @param {*} js - JavaScript code to be added.
         * @param {Symbol} key - If supplied, js will replace any previous JavaScript with the same key
         */
        AppendJs(js, key)
        {
            if (key)
            {
                if (typeof key !== 'symbol')
                    throw Error('AppendJs key must be a Symbol. You can create one with Symbol()');

                getCurrentJob().page.thisBuild.keyedInlineJs.set(key, js);
            }
            else
                getCurrentJob().page.thisBuild.inlineJs.push(js);
        },

        /**
         * Determine whether JavaScript with supplied key has been previously appended.
         * @param {Symbol} key - JavaScript key
         */
        HasJs(key)
        {
            return getCurrentJob().page.thisBuild.keyedInlineJs.has(key);
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
         * EvaluateNow JSX immediately - useful for parents that want children to pass data up to them via context.
         * 
         * Normally, parents are evaluated before their children.
         * 
         * @param {*} jsx - JSX element, or array of, to be rendered
         */
        EvaluateNow(jsx)
        {
            const rendered = renderNow(jsx);
            return new DeferredElement(null, () => rendered);
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
         * @param {string} [outputFilename] - Override the default name of the generated html file
         */
        async Render(outputFilename)
        {
            const { page, commonCss, onRenderStart, onRendered } = getCurrentJob();

            //
            // Let the build system know that this page is fully configured.
            // At this point we can expect any client JS to be compiled.
            //

            // NOTHING ASYNC CAN BE SAFELY INVOKED BEFORE onRenderStart()
            await onRenderStart(outputFilename ?? page.htmlFile);

            if (page.thisBuild.clientJsFileOut)
            {
                // Equivalent to this.AppendHead(<script src={page.thisBuild.clientJsFileOut} async defer></script>);
                this.AppendHead(
                    __nakedjsx__createElement(
                        'script',
                        {
                            src: page.thisBuild.clientJsFileOut,
                            async: true,
                            defer: true
                        })
                    );
            }   

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
            // Inject all necessary inline JS in a single script tag.
            //

            let js = page.thisBuild.inlineJs.join(';\n') + ';\n' + [...page.thisBuild.keyedInlineJs.values()].join(';\n');
            if (js !== ';')
            {
                // this.AppendBody(<script><raw-content content={js}></raw-content></script>);
                this.AppendBody(
                    __nakedjsx__createElement(
                        'script',
                        null,
                        __nakedjsx__createElement(
                            'raw-content',
                            {
                                content: js
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
                        page.outputDir,
                        outputFilename ?? page.htmlFile
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
    