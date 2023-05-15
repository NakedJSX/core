import { parentPort } from 'node:worker_threads';
import path from 'node:path';

import { getCache, currentJob, log } from '../build-system/thread/html-render-worker.mjs';
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
         * @param {string} [outputFilename] - Override the default name of the generated html file
         */
        Render(outputFilename)
        {
            const { page, commonCss } = currentJob;

            // Restore the ScopedCssSet prototype lost when passed to the worker
            Object.setPrototypeOf(page.thisBuild.scopedCssSet, ScopedCssSet.prototype);

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

            const document = __nakedjsx_get_document();

            parentPort.postMessage(
                {
                    rendered:
                        {
                            outputFilename: outputFilename ?? page.htmlFile,
                            htmlContent: document.toHtml({ relativeAssetRoot })
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
        },

        /**
         * Get access to an map that persists between pages and incremental builds
         */
        GetCache(name)
        {
            return getCache(name);
        },

        /**
         * Get the full path for a path relative to the output directory for this page
         */
        GetOutputPath(relativeOutputPath)
        {
            return path.join(currentJob.page.outputDir, relativeOutputPath);
        }
    };
    