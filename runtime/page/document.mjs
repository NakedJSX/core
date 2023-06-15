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
    #context;
    #id;
    #attributes;
    #children;

    constructor(tagName, context)
    {
        this.#tagName       = tagName ? tagName.toLowerCase() : undefined;
        this.#context       = context;
        this.#children      = [];
        this.#attributes    = {};
    }

    get context()
    {
        return this.#context;
    }

    get id()
    {
        return this.#id;
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
        if (key === 'context')
            return; // already set at construction

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
            for (const nestedChild of child)
                this.appendChild(nestedChild);
            
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

export class ServerDocument
{
    constructor(lang)
    {
        this.elementsWithCss = [];

        this.documentElement = new Element("html");
        this.documentElement.setAttribute("lang", lang);

        this.head = this.documentElement.appendChild(new Element("head"));
        this.body = this.documentElement.appendChild(new Element("body"));
    }

    createElement(tagName, context)
    {
        return new Element(tagName, context);
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
