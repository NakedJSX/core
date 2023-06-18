export const assetUriPathPlaceholder = '__NAKEDJSX_ASSET_DIR__';

// These elements are self closing (i.e. <hr>, not <hr/>)
const voidElements =
    new Set(
        [
            'area',
            'base',
            'br',
            'col',
            'embed',
            'hr',
            'img',
            'input',
            'link',
            'meta',
            'source',
            'track',
            'wbr'
        ]);

function empty(s)
{
    if (s === null)
        return true;
    
    if (s === undefined)
        return true;
    
    if (s.toString().trim() === '')
        return true;
    
    return false;
}

export class Element
{
    static #pool = [];

    tagName;
    context;
    id;
    attributes;
    children;

    static From(tagName, context)
    {
        if (this.#pool.length)
        {
            const element = this.#pool.pop();

            element.tagName = tagName;
            element.content = context;
            element.id      = undefined;

            element.children.length = 0;
            element.attributes.clear();

            return element;
        }

        return new Element(tagName, context);
    }

    constructor(tagName, context)
    {
        this.tagName    = tagName;
        this.context    = context;
        this.children   = [];
        this.attributes = new Map();
    }

    release()
    {
        Element.#pool.push(this);
    }

    setAttribute(key, value)
    {
        requireValidAttributeName(key);

        if (key === 'context')
            return; // already set at construction

        // If the value is empty, strip the attribute
        if (empty(value))
            return;

        if (key === 'id')
            this.id = value;

        if (key === 'ref')
        {
            value.set(this);
            return;
        }
        
        this.attributes.set(key, value);
    }

    appendChild(child)
    {
        //
        // Limit what types can be added as child nodes.
        //
        // In particular we want to prevent a boolean from being added,
        // as that lets us use JSX like:
        //
        // { val > 0 && <some JSX> }
        //
        // which can evalulate to 'false'.
        //

        if (Array.isArray(child))
        {
            for (const nestedChild of child)
                this.appendChild(nestedChild);
            
            return child;
        }

        switch (typeof child)
        {
            case 'object':
                if (child.toHtml)
                    this.children.push(child);
                break;

            case 'string':
                this.children.push(child);
                break;
        }

        return child;
    }

    toHtml(renderContext)
    {
        const { relativeAssetRoot } = renderContext;

        var html;

        if (this.tagName)
        {
            //
            // Sometimes we want to inject a raw fragment, such as an SVG.
            // We do this via a custom raw-content tag with a content attribute.
            //

            if (this.tagName === 'raw-content')
                return this.attributes.get('content');

            html = '<' + this.tagName;

            // Attributes
            for (const [key, value] of this.attributes.entries())
            {
                html += ' ' + key;
                
                switch (typeof value)
                {
                    case 'string':
                        switch (key)
                        {
                            case "data":
                            case "srcset":
                            case "src":
                            case "href":
                                html += '="' + escapeHtml(value.replaceAll(assetUriPathPlaceholder, relativeAssetRoot)) + '"';
                                break;

                            default:
                                html += '="' + escapeHtml(value) + '"';
                        }
                        break;

                    case 'number':
                        html += '="' + escapeHtml(value.toString()) + '"';
                        break;
                }   
            }

            html += '>';

            if (voidElements.has(this.tagName))
                return html;
        }
        else
            html = ''; /* Text node */

        for (const child of this.children)
        {
            // if (child.toHtml)
            if (child instanceof Element)
            {
                html += child.toHtml(renderContext);
                child.release();
            }
            else if (typeof child === 'string')
                html += escapeHtml(child);
        }

        if (this.tagName)
            html += '</' + this.tagName + '>';

        return html;
    }
}

/** Caching proxy for a single element */
export class CachingElementProxy
{
    key;
    cacheMap;
    element;

    constructor(key, cacheMap, element)
    {
        this.key        = key;
        this.cacheMap   = cacheMap;
        this.element    = element;
    }

    deferredRender()
    {
        return this;
    }

    toHtml(renderContext)
    {
        let html = this.cacheMap.get(this.key)
        if (html)
            return html;

        if (this.element.toHtml)
            html = this.element.toHtml(renderContext);
        else if (typeof this.element === 'string')
            html = escapeHtml(this.element);

        this.cacheMap.set(this.key, html);
        return html;
    }
}

/** Caching proxy for a an array of element */
export class CachingHtmlRenderer
{
    #html;
    #elements;

    constructor(elements)
    {
        this.#elements = elements;
    }

    deferredRender()
    {
        return this;
    }

    toHtml(renderContext)
    {
        if (this.#html)
            return this.#html;
        
        this.html = '';

        for (const element of this.#elements)
        {
            if (!element)
                continue;
            
            if (element.toHtml)
                this.#html += element.toHtml(renderContext);
            else if (typeof element === 'string')
                this.#html += escapeHtml(element);
        }

        // Don't need the elements anymore
        this.#elements = null;
        
        return this.#html;
    }
}

export class ServerDocument
{
    constructor(lang)
    {
        this.elementsWithCss = [];

        this.documentElement = Element.From("html");
        this.documentElement.setAttribute("lang", lang);

        this.head = this.documentElement.appendChild(Element.From("head"));
        this.body = this.documentElement.appendChild(Element.From("body"));
    }

    toHtml(renderContext)
    {
        return '<!DOCTYPE html>' + this.documentElement.toHtml(renderContext);
    }
}

function requireValidAttributeName(attributeName)
{
    /*
     * The HTML5 spec is much more permissive but lets
     * just support the basics.
     */

    if (/[^a-zA-Z0-9-]/.test(attributeName))
        throw Error("Invalid attribute name: " + attributeName);
}

function escapeHtml(text)
{
    const htmlEscapeMap =
        {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };

    return  text.replace(
        /[&<>"']/g,
        (m) => htmlEscapeMap[m]
        );
}
