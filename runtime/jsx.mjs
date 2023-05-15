let jsxDocument = typeof window === 'object' ? window.document : null;

let contexts = [{}];

/**
 * Obtain current context data provided by parent tags.
 */
export function getContext()
{
    return contexts[contexts.length - 1];
}

/**
 * Add data to context made available by parent tags
 * @param {object} context
 */
export function addContext(contextToAdd)
{
    contexts.push(Object.assign({}, contexts[contexts.length - 1], contextToAdd));
}

/**
 * Provide context to child tags, hide parent conact.
 * @param {object} context
 */
export function setNewContext(context)
{
    contexts.push(context);
}

/**
 * Create a restore point that can be used to reset context to the current state
 * @param {object} context
 */
export function createContextRestorePoint()
{
    return contexts.length;
}

/**
 * Remove all contexts added since the restore point was created
 * @param {object} context
 */
export function restoreContext(restorePoint)
{
    if (restorePoint < 1)
        throw Error(`Bad restore point ${restorePoint} passed to restoreContext`);
    
    while (contexts.length > restorePoint)
        contexts.pop();
}

export function __nakedjsx_set_document(document)
{
    jsxDocument = document;
}

export function __nakedjsx_get_document(document)
{
    return jsxDocument;
}

export function renderNow(deferredRender)
{
    if (typeof deferredRender === 'function')
        return renderNow(deferredRender());
    
    if (Array.isArray(deferredRender))
        return deferredRender.map(deferredRender => renderNow(deferredRender));
    
    return deferredRender;
}

export function __nakedjsx_create_deferred_element()
{
    return () => __nakedjsx_create_element(...arguments); 
}

export function __nakedjsx_create_element(tag, props, ...children)
{
    props = props || {};
    
    if (typeof tag === "function")
    {
        // Make child elements selectively placeable via {props.children}
        props.children = children;

        // Allow the tag implementation to call addContext.
        let restorePoint = createContextRestorePoint();
        
        try
        {
            return renderNow(tag(props, children));
        }
        finally
        {
            // Remove any added contexts
            restoreContext(restorePoint);
        }
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

export function __nakedjsx_create_deferred_fragment()
{
    return () => __nakedjsx_create_fragment(...arguments); 
}

export function __nakedjsx_create_fragment(props)
{
    return props.children;
}

export function __nakedjsx_append_child(parent, child)
{
    if (!jsxDocument)
        throw Error(`Cannot append a JSX child outside of a Page.Create() / Page.Render() pair.`);

    if (!child)
        return;

    child = renderNow(child);
    
    if (Array.isArray(child))
        child.forEach((nestedChild) => __nakedjsx_append_child(parent, nestedChild));
    else if (typeof child === 'string')
        parent.appendChild(jsxDocument.createTextNode(child));
    else
        parent.appendChild(child);
}
