import { getContext, renderNow, setNewContext, createContextRestorePoint, restoreContext } from "./page.mjs";

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

class Element
{
    #tagName;
    #id;
    #attributes;
    #children;
    #jsxDocument;

    constructor(document, tagName)
    {
        this.#jsxDocument   = document;
        this.#tagName       = tagName ? tagName.toLowerCase() : undefined;
        this.#children      = [];
        this.#attributes    = {};
    }

    get id()
    {
        if (this.#id)
            return this.#id;
        
        throw 'Element has no id';
    }

    get tagName()
    {
        return this.#tagName;
    }

    get attributes()
    {
        return this.#attributes;
    }

    get children()
    {
        return this.#children;
    }

    setAttribute(key, value)
    {
        // If the value is empty, strip the attribute
        if (empty(value))
            return;

        if (key === 'id')
            this.#id = value;

        if (key === 'ref')
        {
            value.set(this);
            return;
        }
        
        this.#attributes[key] = value;
    }

    appendChild(child)
    {
        //
        // Limit what types can be added as child nodes.
        //
        // In particular we want to prevent a boolean false from being added,
        // as that lets us use JSX like:
        //
        // { val > 0 && <some JSX> }
        //
        // which can evalulate to 'false'.
        //

        if (Array.isArray(child))
        {
            child.flat().forEach(this.appendChild);
            return child;
        }

        switch (typeof child)
        {
            case 'object':
                if (child.constructor.name === 'Element')
                    this.#children.push(child);        
                break;

            case 'string':
                this.#children.push(child);
                break;
        }

        return child;
    }

    toHtml(renderContext)
    {
        const { relativeAssetRoot } = renderContext;

        var html;

        if (this.#tagName)
        {
            //
            // Sometimes we want to inject a raw fragment, such as an SVG.
            // We do this via a custom raw-content tag with a content attribute.
            //

            if (this.#tagName === 'raw-content')
                return this.#attributes.content;

            requireValidTagName(this.#tagName);

            html = '<' + this.#tagName;

            // Attributes
            for (let [key, value] of Object.entries(this.#attributes))
            {
                requireValidAttributeName(key);
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

            if (voidElements.has(this.#tagName))
                return html;
        }
        else
            html = ''; /* Text node */

        this.#children.forEach(
            child =>
            {
                const type = typeof child;

                if (type === 'object' && child.constructor.name === 'Element')
                    html += child.toHtml(renderContext);
                else if (type === 'string')
                    html += escapeHtml(child);
                
                //
                // Other types not supported.
                //
            });
        
        if (this.#tagName)
            html += '</' + this.#tagName + '>';

        return html;
    }
}

export class Ref
{
    #context;
    #element;

    set(element)
    {
        // Capture the current context, which we'll restore when adding children to this Ref.
        this.#context = getContext();
        this.#element = element;
    }

    appendChild(child)
    {
        let restorePoint = createContextRestorePoint();

        // Restore the context captured when the ref was set
        setNewContext(this.#context);
            
        try
        {
            this.#element.appendChild(renderNow(child));
        }
        finally
        {
            // Remove any added contexts
            restoreContext(restorePoint);
        }
    }
}

export class ServerDocument
{
    constructor(lang)
    {
        this.documentElement = new Element(this, "html");
        this.documentElement.setAttribute("lang", lang);

        this.head = this.documentElement.appendChild(new Element(this, "head"));
        this.body = this.documentElement.appendChild(new Element(this, "body"));
    }

    createElement(tagName)
    {
        return new Element(this, tagName);
    }

    createTextNode(text)
    {
        //
        // This function exists only for compatibility with browser DOM API
        //

        return text;
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
        throw "Invalid attribute name: " + attributeName;
}

function requireValidTagName(tagName)
{
    if (/[^a-zA-Z0-9]/.test(tagName))
        throw "Invalid tag name: " + tagName;
}

function escapeHtml(text)
{
    var map =
        {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
    
    return  text.replace(
                /[&<>"']/g,
                function(m)
                {
                    return map[m];
                });
}
