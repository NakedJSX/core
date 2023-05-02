import { parentPort } from 'node:worker_threads';

import { currentTask, log } from '../build-system/thread/worker.mjs';
import { ServerDocument } from '../build-system/server-document.mjs';
import { ScopedCssSet, finaliseCssClasses } from '../build-system/css.mjs';
import { __nakedjsx_set_document, __nakedjsx_get_document, __nakedjsx_create_element, __nakedjsx_create_fragment, __nakedjsx_append_child } from '@nakedjsx/core/jsx';

//
// The node specific functionality for worker communication needs
// to be in a separate file from the common JSX code that is also
// used clientside.
//

export const Page =
    {
        Create(lang)
        {
            __nakedjsx_set_document(new ServerDocument(lang));
        },

        Render()
        {
            const { page, commonCss } = currentTask;

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

            parentPort.postMessage(__nakedjsx_get_document().toHtml());
        },

        AppendHead(child)
        {
            __nakedjsx_append_child(__nakedjsx_get_document().head, child);
        },

        AppendBody(child)
        {
            __nakedjsx_append_child(__nakedjsx_get_document().body, child);
        }
    };
    