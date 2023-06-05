import postcssNested from 'postcss-nested';
import postcss from 'postcss';
import * as syntax from 'csso/syntax';

import { log, warn, convertToBase } from "../build-system/util.mjs";

const postcssProcessor  = postcss(postcssNested);
const loadCssCache      = new Map();
const reserveCssCache   = new Map();

export class ScopedCssSet
{
    // A set of reserved CSS class names for the generator to avoid.
    reserved;

    // className -> { cssCodeDedup, cssCodeFinal }
    allClasses;

    // cssCodeDedup -> className
    cssToClassName;

    // Used to generate the next CSS class name.
    nextClassNameIndex;
    
    constructor(reserved = new Set())
    {
        this.reserved           = reserved;
        this.allClasses         = new Map();
        this.cssToClassName     = new Map();
        this.nextClassNameIndex = 0;
    }

    subset(classNames)
    {
        // Assumes the subset wants to avoid the same reserved names ...
        const scopedCssSet = new ScopedCssSet(this.reserved);
        
        for (const className of classNames)
        {
            const existingClass = this.allClasses.get(className);

            if (!existingClass)
                throw new Error(`Attempt to create ScopedCssSet subset including non-existent class: ${className}`);
        
            scopedCssSet.addCss(className, existingClass.cssCodeDedup, existingClass.cssCodeFinal);
        }

        return scopedCssSet;
    }

    collateAll()
    {
        let collatedCss = '';

        for (const [key, value] of this.allClasses)
            collatedCss += value.cssCodeFinal;
        
        return collatedCss;
    }

    getClassName(scopedCss)
    {
        //
        // Scoped CSS doesn't include a top level class name,
        // but optionally includes nested CSS for child elements.
        //
        // For example:
        //
        //     margin: var(--gap-2) auto;
        //     padding: 0 var(--gap);
        //
        //     #email {
        //         display: block;
        //         margin: 0 auto var(--gap-2);
        //         max-width: var(--max-width-email);
        //         width: 100%;
        //     }
        //
        // This class sets margin and padding to the target element,
        // and additionally sets CSS for any child element with id 'email'.
        //
        // This function will wrap the code in a generated class name,
        // then compile and optimise it to a standard form. If the
        // standard form has not been seen before, allocate it a final
        // class name and return it. Otherwise, it returns the previously
        // allocated class name.
        //
        // If the standard form is empty, then an empty string is returned.
        //

        // First find a string that doesn't exist within the CSS code to use as a temporary classname, needed for loadCss(...)
        let tmpClassName = '_';
        while (scopedCss.includes(tmpClassName))
            tmpClassName += '_';

        // This will optimise the CSS to a standard form, ideal for deduplication
        const cssCodeDedup = loadCss(`.${tmpClassName}{${scopedCss}}`);

        // The CSS may optimise away to nothing
        if (!cssCodeDedup)
            return '';

        let className = this.cssToClassName.get(cssCodeDedup);
        if (className)
            return className;
        
        //
        // We've not seen this scoped CSS before, allocate it a new classname.
        // Be sure to avoid clashing with reserved classnames and classes
        // manually added via addCss(...).
        //

        do
        {
            className = convertToBase(this.nextClassNameIndex++, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ");
        }
        while (this.reserved.has(className) || this.allClasses.has(className));

        //
        // Replace the temporary class name to create the the final CSS code
        //

        const cssCodeFinal = cssCodeDedup.replaceAll(tmpClassName, className);

        this.addCss(className, cssCodeDedup, cssCodeFinal);

        return className;
    }

    addCss(className, cssCodeDedup, cssCodeFinal)
    {
        this.cssToClassName.set(cssCodeDedup, className);
        this.allClasses.set(className, { cssCodeDedup, cssCodeFinal });
    }

    reserveCommonCssClasses(commonCss)
    {
        const reserved = this.reserved;

        //
        // We avoid generating a class name that clashes with a class
        // manually predefined in the common js.
        //

        let cacheResult = reserveCssCache.get(commonCss);
        if (cacheResult)
        {
            for (const reservedClass of cacheResult)
                reserved.add(reservedClass);
            
            return;
        }

        cacheResult = [];

        syntax.walk(
            syntax.parse(commonCss),
            {
                visit: 'ClassSelector',
                enter(node, item, list)
                {
                    cacheResult.push(node.name);
                    reserved.add(node.name);
                }
            });
        
        reserveCssCache.set(commonCss, cacheResult)
    }
}

export function finaliseCssClasses(document, commonCss, scopedCssSet)
{
    //
    // Now that the document is complete, find all elements that have a CSS attribute.
    // Then output a bunch of CSS classes, deduplicating as appropriate.
    //

    findElements(document.body);

    return loadCss(
        commonCss + scopedCssSet.collateAll(),
        {
            renameVariables: true
        });

    function findElements(element)
    {
        processElement(element);

        if (!element?.children)
            return;

        for (const child of element.children)
            findElements(child);
    }

    function processElement(element)
    {
        if (!element?.attributes?.css)
            return;
        
        let className = scopedCssSet.getClassName(element.attributes.css)
        delete element.attributes.css;
        
        if (!className)
            return;

        if (element.attributes.class)
            element.attributes.class += ' ' + className;
        else
            element.attributes.class = className;
    }
}

export function loadCss(input, options)
{
    const cacheKey      = input + JSON.stringify(options)
    const cacheResult   = loadCssCache.get(cacheKey);

    if (cacheResult)
        return cacheResult;

    //
    // First use postcss-nested to flatten nested CSS
    //

    let css = postcssProcessor.process(input, { from: undefined }).css;

    //
    // Get the uncompressed ast
    //

    let ast = syntax.parse(css);

    //
    // Perform an initial compression so that subsequent custom
    // compression operations are measuing their real impact.
    //

    const minifyOptions = { comments: false };

    ast = syntax.compress(ast, minifyOptions).ast;

    //
    // Conditionally apply our custom CSS variable compression
    //

    if (options?.renameVariables)
    {
        compressCssVariables(
            ast,
            "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
            [ /* variable names to keep can go in here */ ]);
    }    

    //
    // Now generate the final CSS
    //

    const result = syntax.generate(ast);
    loadCssCache.set(cacheKey, result);

    return result;
}

function compressCssVariables(cssAst, digitSymbols, namesToPreserve = [])
{
    //
    // First gather information about variable declarations.
    //

    const cssVars = {};

    syntax.walk(
        cssAst,
        {
            visit: 'Declaration',
            enter(node, item, list)
            {
                if (!node.property.startsWith('--'))
                    return;

                const name = node.property;
                const cssVar = cssVars[name];

                if (!cssVar)
                {
                    cssVars[name] = { declareCount: 1, useCount: 0, value: node.value.value };
                    return;
                }

                //
                // This CSS variable has been declared more than once.
                //
                // If it has been declared again with the same value, we pretend
                // that it wasn't. This allows us to consider flattening it away.
                //

                if (node.value.value === cssVar.value)
                    return;

                //
                // This is probably a variable that varies based on a media query.
                //

                if (cssVar.declareCount++ == 1)
                {
                    cssVar.values = [ cssVar.value, node.value.value ];
                    delete cssVar.value; // no longer accurate
                }
                else
                    cssVar.values.push(node.value.value);
            }
        });

    //
    // Now look at variable usage.
    //

    syntax.walk(
        cssAst,
        {
            visit: 'Function',
            enter(node, item, list)
            {
                if (node.name != 'var')
                    return;

                const name = node.children.head.data.name;
                const cssVar = cssVars[name];

                if (!cssVar)
                {
                    warn(`css variable ${name} used but not declared`);
                    return;
                }
        
                cssVar.useCount++;

                return this.skip;
            }
        });
    
    //
    // Strip out any variable declarations that were not used.
    //

    syntax.walk(
        cssAst,
        {
            visit: 'Declaration',
            enter(node, item, list)
            {
                const name = node.property;
                const cssVar = cssVars[name];

                if (!cssVar)
                    return;
                
                if (cssVar.useCount === 0)
                {
                    if (!list)
                    {
                        err(`could not remove css var ${name}`);
                        return;
                    }

                    list.remove(item);
                }
            }
        });

    //
    // Sort the variables from most to least used. This causes the shortest
    // replacement names to be allocated to the most commonly used variables.
    //

    const sortedNameUsage = Object.entries(cssVars).sort(([,a], [,b]) => b.useCount - a.useCount);

    //
    // Now make flattening and replacement decisions
    //

    const preserveNames         = new Set(namesToPreserve);
    const renamedVariables      = new Map();
    const flattenedVariables    = new Set();
    
    let nextNameIndex = 0;
    let nextCssVarName;
    
    function createNextName()
    {
        nextCssVarName = '--' + convertToBase(nextNameIndex++, digitSymbols);
    }

    createNextName();
    
    for (const [name, cssVar] of sortedNameUsage)
    {
        if (preserveNames.has(name))
            continue;
        
        if (!cssVar.useCount) // then the rest will also have zero usage
            break;

        //
        // If the var is declared more than once we keep it as a variable
        // so that a media query can change its value at runtime.
        //
        // Also keep variables that are declared once but have a value
        // large enough such that flattening it would take more space.
        //

        let rename = false;

        if (cssVar.declareCount > 1)
            rename = true;
        else
        {
            //
            // We can assume that length == bytes for our CSS var names, due to ASCII naming.
            //

            const declationLength = `${nextCssVarName}:${cssVar.value};`.length;
            const totalRenamedLength = declationLength + (cssVar.useCount * `var(${nextCssVarName})`.length);

            //
            // TODO we should serialise the utf value to bytes to get the real length
            //

            const totalFlattenedLength = cssVar.useCount * cssVar.value.length;

            if (totalRenamedLength < totalFlattenedLength)
                rename = true;
        }
        
        if (rename)
        {
            renamedVariables.set(name, nextCssVarName);
            createNextName();
            continue;
        }

        //
        // The variable is declared once, but has a short value so
        // we can save space by replacing all use of the variable
        // with the value itself.
        //

        flattenedVariables.add(name);
    }

    //
    // Finally, apply our flattening and name replacements
    //
    // Start with removing / renaming declarations
    //

    syntax.walk(
        cssAst,
        {
            visit: 'Declaration',
            enter(node, item, list)
            {
                const name = node.property;
                
                if (flattenedVariables.has(name))
                {
                    if (!list)
                        throw new Error(`Could not remove flatten declaration of ${name}`);

                    list.remove(item);
                }
                else if (renamedVariables.has(name))
                {
                    node.property = renamedVariables.get(name);
                }
            }
        });

    //
    // Then replace var(--*) function calls with renamed vars, or flattened values
    //

    syntax.walk(
        cssAst,
        {
            visit: 'Function',
            enter(node, item, list)
            {
                if (node.name != 'var')
                    return;

                const name = node.children.head.data.name;

                if (flattenedVariables.has(name))
                {
                    delete node.children;
                    node.type = 'Identifier';
                    node.name = cssVars[name].value;
                }
                else if (renamedVariables.has(name))
                {
                    node.children.head.data.name = renamedVariables.get(name);
                }

                return this.skip;
            }
        });
}
