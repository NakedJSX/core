let jsxDocument;

export const JSX =
    {
        SetDocument(document)
        {
            if (jsxDocument)
                throw Error(`JSX.CreateDocument() called when jsxDocument is already set to ${jsxDocument}`);

            jsxDocument = document;
        },

        GetDocument()
        {
            return jsxDocument;
        },

        CreateElement(tag, props, ...children)
        {
            // Allow JSX functions to assume props is an object
            if (!props)
                props = {};            

            if (typeof tag === "function")
                return tag(props, children);

            const element = jsxDocument.createElement(tag);

            Object.entries(props || {}).forEach(
                ([name, value]) =>
                {
                    if (typeof window !== 'undefined' && name.startsWith('on') && name.toLowerCase() in window)
                        element.addEventListener(name.toLowerCase().substring(2), value);
                    else if (name === 'className')
                        element.setAttribute('class', value);
                    else
                        element.setAttribute(name, value);
                });

            children.forEach((child) => JSX.AppendChild(element, child));

            return element;
        },

        CreateFragment(props, ...children)
        {
            return children;
        },

        AppendChild(parent, child)
        {
            if (!child)
                return;
            
            if (Array.isArray(child))
                child.forEach((nestedChild) => JSX.AppendChild(parent, nestedChild));
            else
                parent.appendChild(child.nodeType ? child : jsxDocument.createTextNode(child));
        },

        AppendHead(child)
        {
            JSX.AppendChild(jsxDocument.head, child);
        },

        AppendBody(child)
        {
            JSX.AppendChild(jsxDocument.body, child);
        }
    };

// Automatically use the window document if it's available
if (typeof window !== 'undefined' && window.document)
    JSX.SetDocument(window.document);