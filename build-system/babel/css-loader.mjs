import postcssNested from 'postcss-nested';
import postcss from 'postcss';
import * as csstree from 'css-tree';
import { compress, generate } from 'csso/syntax';
import { convertToBase, warn, err } from '../util.mjs';

const postcssProcessor = postcss(postcssNested);
const cache = new Map();

function compressCssVariables(cssAst, digitSymbols, namesToPreserve = [])
{
    //
    // First gather information about variable declarations.
    //

    const cssVars = {};

    csstree.walk(
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
                // This css variable has been declared more than once.
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

    csstree.walk(
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

    csstree.walk(
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
            // We can assume that length == bytes for our css var names, due to ASCII naming.
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

    csstree.walk(
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

    csstree.walk(
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

export function loadCss(input, options)
{
    const beforeMs      = new Date().getTime();
    
    const cacheKey      = input + JSON.stringify(options)
    const cacheResult   = cache.get(cacheKey);

    if (cacheResult)
        return cacheResult;

    //
    // First use postcss-nested to flatten nested css
    //

    let css = postcssProcessor.process(input, { from: undefined }).css;

    //
    // Get the uncompressed ast
    //

    let ast = csstree.parse(css);

    //
    // Perform an initial compression so that subsequent custom
    // compression operations are measuing their real impact.
    //

    const minifyOptions = { comments: false };

    if (options?.development)
    {
        // Retain /*! */ style comments, useful for debugging our scoped css
        minifyOptions.comments = 'exclamation';
    }

    ast = compress(ast, minifyOptions).ast;

    //
    // Conditionally apply our custom css variable compression
    //

    if (options?.renameVariables)
    {
        compressCssVariables(
            ast,
            "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
            [ /* variable names to keep can go in here */ ]);
    }    

    //
    // Now generate the final css
    //

    const result = generate(ast);
    cache.set(cacheKey, result);

    // log(`loadcss took ${new Date().getTime() - beforeMs} ms `);

    return result;
}