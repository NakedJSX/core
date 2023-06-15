//
// Wrap Element.appendChild() so that it can add an array of elements,
// which allows a JSX fragment to be passed to appendChild.
// Additionally, strings are converted to text nodes.
//

const originalAppendChild = Element.prototype.appendChild;
Element.prototype.appendChild =
    function(child)
    {
        if (Array.isArray(child))
        {
            for (const childArrayMember of child)
                this.appendChild(childArrayMember);
        
            return child;
        }
        else if (typeof child === 'string')
            return originalAppendChild.call(this, document.createTextNode(child));
        else if (child)
            return originalAppendChild.call(this, child);
    };

export function __nakedjsx__createElement(tag, props, ...children)
{
    props = props || {};
    
    if (typeof tag === "function")
    {
        // Make child elements selectively placeable via {props.children}
        props.children = children;

        return tag(props);
    }

    //
    // We're dealing with regular HTML, not a JSX function
    //

    const element = document.createElement(tag);

    for (const [name, value] of Object.entries(props))
    {
        if (name.startsWith('on'))
        {
            const lowercaseName = name.toLowerCase();
            
            if (lowercaseName in window)
            {
                element.addEventListener(lowercaseName.substring(2), value);
                continue;
            }
        }
        
        element.setAttribute(name, value);
    };
    
    for (const child of children)
        element.appendChild(child);

    return element;
}

export function __nakedjsx__createFragment(props)
{
    return props.children;
}