import path from 'node:path';

import { AsyncLocalStorage } from 'node:async_hooks';

import { getCurrentJob } from '../../build-system/nakedjsx.mjs';
import { finaliseCssClasses } from '../../build-system/css.mjs';
import { Ref, ServerDocument } from './document.mjs';

const asyncLocalStorage = new AsyncLocalStorage();

export function runWithAsyncLocalStorage(callback)
{
    //
    // Our simple static Page.* API is enabled by the
    // current document being stored in async local
    // storage. The entire dynamic import() of the
    // rolled up page generation file is via here.
    //

    asyncLocalStorage.run(
        {
            contexts: [{}]
        },
        callback);
}

/**
 * Obtain current context data provided by parent tags.
 */
export function getContext()
{
    const { contexts } = asyncLocalStorage.getStore();
    return contexts[contexts.length - 1];
}

/**
 * Add data to context made available by parent tags
 * @param {object} context
 */
export function addContext(contextToAdd)
{
    const { contexts } = asyncLocalStorage.getStore();
    contexts.push(Object.assign({}, contexts[contexts.length - 1], contextToAdd));
}

/**
 * Provide context to child tags, hide parent conact.
 * @param {object} context
 */
export function setNewContext(context)
{
    const { contexts } = asyncLocalStorage.getStore();
    contexts.push(context);
}

/**
 * Create a restore point that can be used to reset context to the current state
 * @param {object} context
 */
export function createContextRestorePoint()
{
    const { contexts } = asyncLocalStorage.getStore();
    return contexts.length;
}

/**
 * Remove all contexts added since the restore point was created
 * @param {object} context
 */
export function restoreContext(restorePoint)
{
    if (restorePoint < 1)
        return;
    
    const { contexts } = asyncLocalStorage.getStore();
    asyncLocalStorage.getStore().contexts = contexts.slice(0, restorePoint);
}

export function __nakedjsx_set_document(document)
{
    asyncLocalStorage.getStore().document = document;
}

export function __nakedjsx_get_document(document)
{
    return asyncLocalStorage.getStore().document;
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

export function __nakedjsx_create_deferred_element()
{
    return () => __nakedjsx_create_element(...arguments); 
}

export function __nakedjsx_create_element(tag, props, ...children)
{
    props = props || {};
    
    if (typeof tag === "function")
    {
        // Make child elements selectively placeable via {props.children}
        props.children = children;

        // Allow the tag implementation to call addContext.
        let restorePoint = createContextRestorePoint();
        
        try
        {
            return renderNow(tag(props, children));
        }
        finally
        {
            // Remove any added contexts
            restoreContext(restorePoint);
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

export function __nakedjsx_create_deferred_fragment()
{
    return () => __nakedjsx_create_fragment(...arguments); 
}

export function __nakedjsx_create_fragment(props)
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

export const Page =
    {
        /**
         * Begin construction of a HTML document.
         * @param {string} lang - Will be placed in the 'lang' attribute of the html tag.
         */
        Create(lang)
        {
            __nakedjsx_set_document(new ServerDocument(lang));
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
                    __nakedjsx_create_element(
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
            const finalCss = finaliseCssClasses(__nakedjsx_get_document(), commonCss, page.thisBuild.scopedCssSet);
            if (finalCss)
                this.AppendHead(
                    __nakedjsx_create_element(
                        'style',
                        null,
                        __nakedjsx_create_element(
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
                    __nakedjsx_create_element(
                        'script',
                        null,
                        __nakedjsx_create_element(
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

            onRendered(__nakedjsx_get_document().toHtml({ relativeAssetRoot }));

            __nakedjsx_set_document(null);
        },

        /**
         * Append JSX to the head tag.
         * @param {*} child - JSX to be appended to the head tag.
         */
        AppendHead(child)
        {
            __nakedjsx_append_child(__nakedjsx_get_document().head, child);
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
            __nakedjsx_append_child(__nakedjsx_get_document().body, child);
        },

        /**
         * Create a Ref that can be passed to a JSX element to capture a reference to it.
         */
        CreateRef()
        {
            return new Ref();
        },

        /**
         * Get the full path for a path relative to the output directory for this page
         */
        GetOutputPath(relativeOutputPath)
        {
            return path.join(getCurrentJob().page.outputDir, relativeOutputPath);
        }
    };
    