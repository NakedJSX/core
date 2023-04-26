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
    jsxDocument;

    constructor(document, tagName)
    {
        this.jsxDocument    = document;
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
        {
            this.#id = value;
            this.jsxDocument.indexElement(this);
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

    toHtml()
    {
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
            for (const [key, value] of Object.entries(this.#attributes))
            {
                requireValidAttributeName(key);
                html += ' ' + key;
                
                switch (typeof value)
                {
                    case 'string':
                        html += '="' + escapeHtml(value) + '"';
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
                    html += child.toHtml();
                else if (type === 'string')
                    html += escapeHtml(child);
                
                //
                // Other types not supported.
                //
            });
        
        if (this.#tagName)
        {
            requireValidTagName(this.#tagName);
            html += '</' + this.#tagName + '>';
        }

        return html;
    }
}

export class ServerDocument
{
    #idToElementMap = {};

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

    createTextNode(textOrElement)
    {
        /* For some reason, sometimes JSX tries to create a text node from a previously created element */
        let node = new Element(this);
        node.appendChild(textOrElement);
        return node;
    }

    indexElement(element)
    {
        this.#idToElementMap[element.id] = element;
    }

    toHtml()
    {
        return '<!DOCTYPE html>' + this.documentElement.toHtml();
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
