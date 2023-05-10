import { parentPort } from 'node:worker_threads';

import { currentJob, log } from '../build-system/thread/html-render-worker.mjs';
import { Ref, ServerDocument } from '../build-system/server-document.mjs';
import { ScopedCssSet, finaliseCssClasses } from '../build-system/css.mjs';
import { __nakedjsx_set_document, __nakedjsx_get_document, __nakedjsx_create_element, __nakedjsx_create_fragment, __nakedjsx_append_child } from '@nakedjsx/core/jsx';

//
// The node specific functionality for worker communication needs
// to be in a separate file from the common JSX code that is also
// used clientside.
//

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
         * @param {string} [htmlFilePath] - Override default output file.
         */
        Render(htmlFilePath)
        {
            const { page, commonCss } = currentJob;

            // Restore the ScopedCssSet prototype lost when passed to the worker
            Object.setPrototypeOf(page.thisBuild.scopedCssSet, ScopedCssSet.prototype);

            if (page.thisBuild.clientJsFileOut)
            {
                // this.AppendHead(<script src={page.thisBuild.clientJsFileOut} async defer></script>);
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

            // this.AppendHead(<style><raw-content content={finaliseCssClasses(__nakedjsx_get_document(), commonCss, page.thisBuild.scopedCssSet)}></raw-content></style>);
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
            // Render the document to HTML and pass result back to the build thread.
            //

            parentPort.postMessage(
                {
                    rendered:
                        {
                            htmlFilePath,
                            htmlContent: __nakedjsx_get_document().toHtml()
                        }
                });

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
        }
    };
    