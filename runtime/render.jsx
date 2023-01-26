import { workerData, parentPort } from 'node:worker_threads';

import { JSX as CommonJSX } from './jsx.jsx';
import { ServerDocument } from './server-document.mjs';

//
// Patch the existing JSX export with static generation functionality.
// We can't place this in a single jsx source file as client side code
// will choke on the node imports.
//

export const JSX = CommonJSX;

JSX.CreateDocument =
    (lang) =>
    {
        JSX.SetDocument(new ServerDocument(lang));
    }

JSX.RenderDocument =
    () =>
    {
        const jsxDocument = JSX.GetDocument();

        if (typeof window !== 'undefined' && jsxDocument === window.document)
            throw Error('RenderDocument() called when JSX.GetDocument() === window.document');
        
        const page = workerData.page;

        if (page.thisBuild.clientJsFileOut)
            JSX.AppendHead(<script src={page.thisBuild.clientJsFileOut} async defer></script>);

        if (page.thisBuild.inlineCss)
            JSX.AppendHead(<style><raw-content content={page.thisBuild.inlineCss}></raw-content></style>);

        if (page.thisBuild.inlineJs)
            JSX.AppendBody(<script><raw-content content={page.thisBuild.inlineJs}></raw-content></script>);

        parentPort.postMessage(JSX.GetDocument().toHtml());
    }
