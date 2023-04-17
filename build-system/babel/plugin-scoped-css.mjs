import fs from 'node:fs';

import pkg_generator from '@babel/generator';
import { loadCss } from './css-loader.mjs';
import { err, convertToBase } from '../util.mjs';

const generate = pkg_generator.default;

// Used to generate css class names
let nextClassNameIndex          = 0;

const cssCodeDedupToClassName   = new Map();
const allCssClasses             = new Map();
const cssOriginFileInfos        = new Map();

export function collateCss(jsModules)
{
    const dedup = new Set();
    const nl = '\n';

    let output = '';

    //
    // Collate the css needed for each module in jsModules.
    //

    for (let jsModule of jsModules)
    {
        const fileInfo = getCssOriginInfo(jsModule);

        if (!fileInfo)
            continue;

        // output += `/*! ${jsModule} */${nl}`;

        for (let cssClassName of fileInfo.classes)
        {
            // Only output the class once, as sometimes multiple files emit identical classes with same hash
            if (dedup.has(cssClassName))
                continue;
            
            dedup.add(cssClassName)

            output += `${allCssClasses.get(cssClassName).cssCodeFinal}${nl}`;
        };
    }
    
    return output;
}

export function getCssClassName(associatedFile, cssCode)
{
    if (typeof associatedFile === 'string')
    {
        //
        // This is the case when called from outside of this plugin,
        // for example to generate a css class associated with an image
        // asset.
        //

        const existingInfo = getCssOriginInfo(associatedFile);

        if (existingInfo)
            associatedFile = existingInfo;
        else
            associatedFile = createCssOriginInfo(associatedFile)
    }

    //
    // We want our deduplication system to work based on compiled css,
    // such that css="color: red" and css="color: red;" output the same
    // code, and therefore produce a single shared css class.
    //

    // Find a string that doesn't exist within the css code to use as a temporary classname
    let tmpClassName = '_';
    while (cssCode.includes(tmpClassName))
        tmpClassName += '_';

    // Put the class through the same compilation process used on the overall result
    const cssCodeDedup = loadCss(`.${tmpClassName}{${cssCode}}`);

    // If the css optimised away, we're done
    if (!cssCodeDedup)
        return;

    //
    // Have we seen this code before?
    //

    let cssClassName = cssCodeDedupToClassName.get(cssCodeDedup)

    if (cssClassName)
    {
        //
        // Reusing an existing class.
        //
        
        // log(`  CSS Class: ${cssClassName}`);
    }
    else
    {
        cssClassName = convertToBase(nextClassNameIndex++, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ");
        cssCodeDedupToClassName.set(cssCodeDedup, cssClassName);
    
        // log(`  CSS Class: ${cssClassName} (new)`);

        //
        // Replace the temporary class name to create the the final css code
        //

        const cssCodeFinal = cssCodeDedup.replaceAll(tmpClassName, cssClassName);
        allCssClasses.set(cssClassName, { cssCodeDedup, cssCodeFinal });
    }

    associatedFile.classes.add(cssClassName);
    return cssClassName;
}

function removeQueryString(importPath)
{
    const queryIndex = importPath.indexOf('?');

    if (queryIndex != -1)
        return importPath.substring(0, queryIndex);
    else
        return importPath;
}

function getCssOriginInfo(filePath)
{
    filePath = removeQueryString(filePath);

    return cssOriginFileInfos.get(filePath);
}

function createCssOriginInfo(filePath)
{
    filePath = removeQueryString(filePath);

    const info =
        {
            filePath,
            mtime:                      fs.statSync(filePath).mtimeMs,
            classes:                    new Set(),
            jsPathsWithCssAttributes:   new Set()
        };

    cssOriginFileInfos.set(filePath, info);
    return info;
}

// babel plugin implementation
export default function(babel)
{
    const t = babel.types;

    let currentFileInfo;

    function getNodeStringValue(node)
    {
        if (t.isStringLiteral(node))
            return node.value;

        if (t.isTemplateLiteral(node))
        {
            //
            // JavaScript template literals are used for multiline strings.
            //
            // The embedded variable syntax is not supported as this would
            // require eval() at compile time and would be of limited benefit.
            //

            if (node.expressions.length > 0 || node.quasis.length != 1)
            {
                err(`Javascript variables within scoped css attributes are not currently supported. If you need this, consider using a style={\`...\`} attribute instead.\n    at file://${currentFileInfo.filePath}:${node.loc.start.line}:${node.loc.start.column}`);
                return undefined;
            }

            return node.quasis[0].value.cooked;
        }

        if (t.isJSXExpressionContainer(node))
            return getNodeStringValue(node.expression);
        
        return undefined;
    }

    return {
        pre(file)
        {
            //
            // Called before each file is parsed.
            //
            // Prepare to update the global view of scoped css in this file
            //

            currentFileInfo = getCssOriginInfo(this.filename)

            if (currentFileInfo)
            {
                if (cssOriginFileInfos.mtime === fs.statSync(this.filename).mtimeMs)
                {
                    //
                    // We have already processed this file
                    //

                    file.path.stop();
                    return;
                }
            }
            else
                currentFileInfo = createCssOriginInfo(this.filename);
        },
        visitor:
            {
                JSXAttribute(nodePath)
                {
                    if (nodePath.node.name.name !== 'css')
                        return;
                    
                    //
                    // The current JSX opening element has at least one css="..." attribute.
                    // We'll collate these when parse exits the JSX opening node.
                    //
                    
                    currentFileInfo.jsPathsWithCssAttributes.add(nodePath.parentPath);
                },

                JSXOpeningElement:
                {
                    exit(nodePath)
                    {
                        if (!currentFileInfo.jsPathsWithCssAttributes.has(nodePath))
                            return;
                        
                        currentFileInfo.jsPathsWithCssAttributes.delete(nodePath);

                        //
                        // This JSXOpeningElement has at least one css attribute.
                        //
                        // For each, convert to a class name add to the className attribute,
                        // if present. More than one className is invalid, but in this case 
                        // the last one 'wins').
                        //

                        const attributes = nodePath.node.attributes;
                        const pathsToRemove = [];
                        const cssClasses = [];
                        let classNamePath;
                        
                        attributes.forEach(
                            (attribute, i) =>
                            {
                                if (attribute.name.name == 'className')
                                {
                                    classNamePath = nodePath.get('attributes.' + i);
                                    return;
                                }
                                
                                if (attribute.name.name == 'css')
                                {
                                    pathsToRemove.push(nodePath.get('attributes.' + i));

                                    //
                                    // Obtain the css code.
                                    //
                                    
                                    const cssCode = getNodeStringValue(attribute.value);
                                    if (cssCode === undefined)
                                        throw nodePath.buildCodeFrameError(`Unhandled css attribute of type: ${attribute.value.type} in: ${generate(attribute.value).code}`);
                                    
                                    const cssClassName = getCssClassName(currentFileInfo, cssCode);
                                    if (!cssClassName)
                                        return;
                                    
                                    cssClasses.push(cssClassName);
                                }
                            });

                        //
                        // Remove the css="..." attributes from the JSX node
                        //
                        
                        pathsToRemove.forEach(pathToRemove => pathToRemove.remove());
                        
                        //
                        // Finally, ensure there is a className attribute, and then populate it with extracted classes
                        //

                        if (classNamePath)
                        {
                            //
                            // Already exists, append our extracted classes.
                            //
                            // If the existing value can be correctly reduced to a string, then
                            // produce a new string with the additional css class names appended.
                            //
                            // If not, replace with code that will append the class names at runtime.
                            //

                            const value = classNamePath.node.value;
                            const existingClassNames = getNodeStringValue(value);

                            if (existingClassNames)
                                classNamePath.node.value = t.stringLiteral([existingClassNames, ...Array.from(cssClasses)].join(' '));
                            else if (t.isJSXExpressionContainer(value))
                                classNamePath.node.value = t.binaryExpression('+', value.expression, t.stringLiteral(' ' + Array.from(cssClasses).join(' ')));
                            else
                                throw nodePath.buildCodeFrameError(`Unhandled className attribute of type: ${value.type} in: ${generate(value).code}`);
                        }
                        else
                        {
                            //
                            // No existing className attribute on this JSX node, add one with our generated classes.
                            //

                            const classNameAttribute = t.jsxAttribute(t.jsxIdentifier("className"), t.stringLiteral(Array.from(cssClasses).join(' ')));
                            classNamePath = nodePath.unshiftContainer('attributes', classNameAttribute);
                        }
                    }
                }
            },
        post()
        {
            //
            // Cleanup state set in pre()
            //
            
            currentFileInfo = undefined;
        }
    };
};
