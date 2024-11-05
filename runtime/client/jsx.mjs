const assetUriPathPlaceholder   = /^__NAKEDJSX_ASSET_DIR__/;
const assetAttributeNames       = new Set(['data', 'srcset', 'src', 'href']);

//
// Wrap Element.appendChild() so that it can add an array of elements,
// which allows a JSX fragment to be passed to appendChild.
// Additionally, strings are converted to text nodes.
//

const originalAppendChild = Element.prototype.appendChild;
Element.prototype.appendChild =
    function(child)
    {
        if (child instanceof Node)
            return originalAppendChild.call(this, child);
        else if (Array.isArray(child))
        {
            for (const childArrayMember of child)
                this.appendChild(childArrayMember);
        
            return child;
        }
        else if (child === null || child === undefined)
            return null;
        else
            return originalAppendChild.call(this, document.createTextNode(child.toString()));
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
    // Support the <raw-content> tag for injecting raw HTML
    //

    if (tag === 'raw-content')
    {
        const dummy     = document.createElement('div');
        dummy.innerHTML = props.content;
        return [...dummy.children];
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

        //
        // Skip attributes with a valud of false, null, or undefined.
        //

        if (value === false || value === null || value === undefined)
            continue;

        //
        // Boolean 'true' attribute values are converted to the presence of
        // an attribute with no assigned value.
        //

        if (value === true)
        {
            element.setAttribute(name, '');
            continue;
        }

        //
        // Support capturing a reference to the created element.
        //

        if (name == 'ref')
        {
            if (typeof value === 'object')
                value.current = element;
            else
                console.error('ref must be an object');
            continue;
        }
        
        //
        // Imported assets need to be resolved to their final path
        //

        if (assetAttributeNames.has(name))
            if (typeof value === 'string')
                if (assetUriPathPlaceholder.test(value))
                {
                    element.setAttribute(name, value.replace(assetUriPathPlaceholder, relativeAssetRoot));
                    continue;
                }

        //
        // Default attribute assignment
        //

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

function createRef()
{
    //
    // A Ref is a container that recieves a reference to
    // a created HTML element.
    //

    return {};
}

export const nakedjsx =
    {
        createRef
    };