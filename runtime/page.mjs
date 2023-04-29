import { parentPort } from 'node:worker_threads';

import { currentTask, log } from '../build-system/thread/worker.mjs';
import { JSX } from './jsx.mjs';
import { ServerDocument } from '../build-system/server-document.mjs';
import { ScopedCssSet, finaliseCssClasses } from '../build-system/css.mjs';

//
// The node specific functionality for worker communication needs
// to be in a separate file from the common JSX code that is also
// used clientside.
//

export const Page =
    {
        Create(lang)
        {
            JSX.SetDocument(new ServerDocument(lang));
        },

        Render()
        {
            const jsxDocument = JSX.GetDocument();

            const { page, commonCss } = currentTask;

            // Restore the ScopedCssSet prototype lost when passed to the worker
            Object.setPrototypeOf(page.thisBuild.scopedCssSet, ScopedCssSet.prototype);

            if (page.thisBuild.clientJsFileOut)
            {
                //JSX.AppendHead(<script src={page.thisBuild.clientJsFileOut} async defer></script>);
                JSX.AppendHead(
                    JSX.CreateElement(
                        'script',
                        {
                            src: page.thisBuild.clientJsFileOut,
                            async: true,
                            defer: true
                        })
                    );
            }   

            // if (page.thisBuild.inlineCss)
            {
                //
                // We have our page structure, it's now time to process CSS attributes
                //

                // JSX.AppendHead(<style><raw-content content={finaliseCssClasses(jsxDocument, commonCss, page.thisBuild.scopedCssSet)}></raw-content></style>);
                const finalCss = finaliseCssClasses(jsxDocument, commonCss, page.thisBuild.scopedCssSet);
                if (finalCss)
                    JSX.AppendHead(
                        JSX.CreateElement(
                            'style',
                            null,
                            JSX.CreateElement(
                                'raw-content',
                                {
                                    content: finalCss
                                })
                            )
                        );
            }

            if (page.thisBuild.inlineJs)
            {
                // JSX.AppendBody(<script><raw-content content={page.thisBuild.inlineJs}></raw-content></script>);
                JSX.AppendBody(
                    JSX.CreateElement(
                        'script',
                        null,
                        JSX.CreateElement(
                            'raw-content',
                            {
                                content: page.thisBuild.inlineJs
                            })
                        )
                    );
            }

            parentPort.postMessage(JSX.GetDocument().toHtml());
        },

        //
        // Not strictly necessary to proxy these but makes for a cleaner page api.
        //

        AppendHead: JSX.AppendHead.bind(JSX),
        AppendBody: JSX.AppendBody.bind(JSX),
    };