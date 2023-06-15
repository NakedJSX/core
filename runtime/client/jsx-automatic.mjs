// UNUSED new style runtime that works out much larger than the old style runtime :/

//
// Wrap Element.appendChild() so that it can add an array of elements,
// which allows a JSX fragment to be passed to appendChild.
// Additionally, strings are converted to text nodes.
//

const originalAppendChild = Element.prototype.appendChild;
Element.prototype.appendChild =
    function(child)
    {
        if (child instanceof Element)
            return originalAppendChild.call(this, child);

        if (Array.isArray(child))
        {
            for (const childArrayMember of child)
                this.appendChild(childArrayMember);
            
            // What to return in this case .. we added more than one node
            return child;
        }

        if (typeof child === 'string')
            return originalAppendChild.call(this, document.createTextNode(child));

        //
        // <>{children}</> compiles to undefined if there are no children, among other cases
        //

        if (child)
            return originalAppendChild.call(this, child);
    };

export const Fragment = ({ children }) => children;

/* This export is needed for JSX edge case that will probably never happen to a NakedJSX user: https://github.com/facebook/react/issues/20031#issuecomment-710346866*/
export function createElement(tag, props, ...children)
{
    if (children.length == 1)
    {
        props.children = children[0];
        return jsx(tag, props);
    }
    else if (children.length > 1)
    {
        props.children = children;
        return jsxs(tag, props);
    }
    else
        return jsx(tag, props);
}

export const jsxs = jsx;
export function jsx(tag, props)
{
    if (typeof tag === "function")
        return tag(props);

    //
    // We're dealing with regular HTML, not a JSX function
    //

    const element = document.createElement(tag);

    addProps(element, props);

    if (Array.isArray(props.children))
        for (const child of props.children)
            element.appendChild(child);
    else if (props.children)
        element.appendChild(props.children);

    return element;
}

export function __nakedjsx__createFragment(props)
{
    return props.children;
}

function addProps(element, props)
{
    for (const [name, value] of Object.entries(props))
    {
        if (name === 'children' || name === 'context')
        {
            // ignore magic props
            continue; 
        }
        else if (name === 'className')
        {
            element.setAttribute('class', value);
        }
        else if (name.startsWith('on'))
        {
            const lowercaseName = name.toLowerCase();
            
            if (lowercaseName in window)
                element.addEventListener(lowercaseName.substring(2), value);
            else
                element.setAttribute(name, value);
        }
        else
        {
            element.setAttribute(name, value);
        }
    }
}