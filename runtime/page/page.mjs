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
        {
            contexts: [{}]
        },
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

export function __nakedjsx_create_element()
{
    // Deferred so that we can reorder the execution from its depth-first default
    return () => createElement(...arguments); 
}

export function __nakedjsx_create_fragment()
{
    // Deferred so that we can reorder the execution from its depth-first default
    return () => createFragment(...arguments); 
}

export function renderNow(deferredRender)
{
    const { document } = asyncLocalStorage.getStore();

    if (typeof deferredRender === 'function')
        return renderNow(deferredRender());

    if (typeof deferredRender === 'string')
        return document.createTextNode(deferredRender);
    
    if (Array.isArray(deferredRender))
        return deferredRender.map(deferredRender => renderNow(deferredRender));
    
    return deferredRender;
}

function createElement(tag, props, ...children)
{
    props = props || {};
    
    if (typeof tag === "function")
    {
        // Make child elements selectively placeable via {props.children}
        props.children = children;

        // Allow the tag implementation to call addContext.
        let restorePoint = Page.ContextBackup();
        
        try
        {
            return renderNow(tag(props, children));
        }
        finally
        {
            // Remove any added contexts
            Page.ContextRestore(restorePoint);
        }
    }

    //
    // We're dealing with regular HTML, not a JSX component
    //

    const { document }  = asyncLocalStorage.getStore();
    const element       = document.createElement(tag);

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

    children.forEach((child) => __nakedjsx_append_child(element, child));

    return element;
}

function createFragment(props)
{
    return props.children;
}

export function __nakedjsx_append_child(parent, child)
{
    if (!child)
        return;

    child = renderNow(child);

    const { document } = asyncLocalStorage.getStore();
    
    if (Array.isArray(child))
        child.forEach((nestedChild) => __nakedjsx_append_child(parent, nestedChild));
    else if (typeof child === 'string')
        parent.appendChild(document.createTextNode(child));
    else
        parent.appendChild(child);
}

class Ref
{
    #context;
    #element;

    set(element)
    {
        // Capture the current context, which we'll restore when adding children to this Ref.
        this.#context = Page.ContextGet();
        this.#element = element;
    }

    appendChild(child)
    {
        let restorePoint = Page.ContextBackup();

        // Restore the context captured when the ref was set
        Page.ContextSet(this.#context);
            
        try
        {
            this.#element.appendChild(renderNow(child));
        }
        finally
        {
            // Remove any added contexts
            Page.ContextRestore(restorePoint);
        }
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
                    createElement(
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
                    createElement(
                        'style',
                        null,
                        createElement(
                            'raw-content',
                            {
                                content: finalCss
                            })
                        )
                    );

            for (const js of page.thisBuild.inlineJs)
            {
                // this.AppendBody(<script><raw-content content={js}></raw-content></script>);
                this.AppendBody(
                    createElement(
                        'script',
                        null,
                        createElement(
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

        /**
         * Append JSX to the head tag.
         * @param {*} child - JSX to be appended to the head tag.
         */
        AppendHead(child)
        {
            __nakedjsx_append_child(getDocument().head, child);
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
            __nakedjsx_append_child(getDocument().body, child);
        },

        /**
         * Create a Ref that can be passed to a JSX element to capture a reference to it.
         */
        RefCreate()
        {
            return new Ref();
        },

        //// Page Context API

        /**
         * Obtain current context data provided by parent tags.
         */
        ContextGet()
        {
            const { contexts } = asyncLocalStorage.getStore();
            return contexts[contexts.length - 1];
        },

        /**
         * Add data to context made available by parent tags
         * @param {object} context
         */
        ContextAdd(contextToAdd)
        {
            const { contexts } = asyncLocalStorage.getStore();
            contexts.push(Object.assign({}, contexts[contexts.length - 1], contextToAdd));
        },

        /**
         * Provide context to child tags, hiding parent contex.
         * @param {object} context
         */
        ContextSet(context)
        {
            const { contexts } = asyncLocalStorage.getStore();
            contexts.push(context);
        },

        /**
         * Create a restore point that can be used to reset context to the current state
         * @param {object} context
         */
        ContextBackup()
        {
            const { contexts } = asyncLocalStorage.getStore();
            return contexts.length;
        },

        /**
         * Remove all contexts added since the restore point was created
         * @param {object} context
         */
        ContextRestore(restorePoint)
        {
            if (restorePoint < 1)
                return;
            
            const { contexts } = asyncLocalStorage.getStore();
            asyncLocalStorage.getStore().contexts = contexts.slice(0, restorePoint);
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
    