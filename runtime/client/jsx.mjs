//
// Wrap Element.appendChild so that it can add an array of elements.
// This allows a JSX fragment to be passed to appendChild.
//

const originalAppendChild = Element.prototype.appendChild;
Element.prototype.appendChild =
    function(child)
    {
        const boundAppendChild = originalAppendChild.bind(this);
        if (Array.isArray(child))
            for (const childArrayMember of child)
                this.appendChild(childArrayMember);
        else if (typeof child === 'string')
            boundAppendChild(document.createTextNode(child));
        else
            boundAppendChild(child);
    };

export function __nakedjsx__createElement(tag, props, ...children)
{
    props = props || {};
    
    if (typeof tag === "function")
    {
        // Make child elements selectively placeable via {props.children}
        props.children = children;

        return tag(props, children);
    }

    //
    // We're dealing with regular HTML, not a JSX tag
    //

    const element = document.createElement(tag);

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

    children.forEach((child) => element.appendChild(child));

    return element;
}

export function __nakedjsx__createFragment(props)
{
    return props.children;
}