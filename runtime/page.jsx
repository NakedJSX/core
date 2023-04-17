import { workerData, parentPort } from 'node:worker_threads';

import { JSX } from '@nakedjsx/core/jsx';
import { ServerDocument } from './server-document.mjs';

//
// The node specific functionality for worker communication needs
// to be in a separate file from the common jsx code that is also
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
            
            const page = workerData.page;

            if (page.thisBuild.clientJsFileOut)
                JSX.AppendHead(<script src={page.thisBuild.clientJsFileOut} async defer></script>);

            if (page.thisBuild.inlineCss)
                JSX.AppendHead(<style><raw-content content={page.thisBuild.inlineCss}></raw-content></style>);

            if (page.thisBuild.inlineJs)
                JSX.AppendBody(<script><raw-content content={page.thisBuild.inlineJs}></raw-content></script>);

            parentPort.postMessage(JSX.GetDocument().toHtml());
        },

        //
        // Not strictly necessary to proxy these but makes for a cleaner page api.
        //

        AppendHead: JSX.AppendHead.bind(JSX),
        AppendBody: JSX.AppendBody.bind(JSX),
    };