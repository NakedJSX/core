let jsxDocument = typeof window === 'object' ? window.document : null;

export function __nakedjsx_set_document(document)
{
    jsxDocument = document;
}

export function __nakedjsx_get_document(document)
{
    return jsxDocument;
}

export function __nakedjsx_create_element(tag, props, ...children)
{
    props = props || {};
            
    if (typeof tag === "function")
    {
        // Make child elements selectively placeable via {props.children}
        props.children = children;

        return tag(props, children);
    }

    //
    // We're dealing with regular HTML, not a JSX component
    //

    const element = jsxDocument.createElement(tag);

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

export function __nakedjsx_create_fragment(props, ...children)
{
    return children;
}

export function __nakedjsx_append_child(parent, child)
{
    if (!child)
        return;
    
    if (Array.isArray(child))
        child.forEach((nestedChild) => __nakedjsx_append_child(parent, nestedChild));
    else
        parent.appendChild(child.nodeType ? child : jsxDocument.createTextNode(child));
}
