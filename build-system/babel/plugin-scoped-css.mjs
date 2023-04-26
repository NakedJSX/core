import fs from 'node:fs';

import pkg_generator from '@babel/generator'
const generate = pkg_generator.default;

import { log, err, removeQueryString } from '../util.mjs';
import { ScopedCssSet } from '../css.mjs';

const cssOriginFileInfos = new Map();
const scopedCssSet = new ScopedCssSet();

// Return a ScopedCssSet containing only CSS relevant to files in moduleIds
export function scopedCssSetUsedByModules(moduleIds)
{
    if (!moduleIds)
        return new ScopedCssSet(scopedCssSet.reserved);

    const uniqueClassNames = new Set();

    for (let moduleId of moduleIds)
    {
        const fileInfo = cssOriginFileInfos.get(moduleId);
        if (!fileInfo)
            continue;

        for (let className of fileInfo.referencedClassNames)
            uniqueClassNames.add(className);
    }

    return scopedCssSet.subset(uniqueClassNames.keys());
}

// babel plugin implementation
export default function(babel, options)
{
    const t = babel.types;

    const { commonCss } = options;

    let currentFileInfo;
    let currentElementHasCss = false;

    scopedCssSet.reserveCommonCssClasses(commonCss);

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
                mtime: fs.statSync(filePath).mtimeMs,

                //
                // Because this plugin instance compiles client javascript
                // for multiple pages, the shared scopedCssSet ends up
                // with CSS for client javascript. In order to be able
                // to filter this down when generating inline CSS for a
                // single pagelater, we need to know which client JS files
                // used which classes.
                //
                // The class names are tracked here.
                //

                referencedClassNames: new Set(),

                isStale()
                {
                    return this.mtime !== fs.statSync(this.filePath).mtimeMs;
                }
            };

        cssOriginFileInfos.set(filePath, info);
        return info;
    }

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
                err(`Javascript variables within scoped css attributes are not currently supported in client Javascript. If you need this, consider using a style={\`...\`} attribute instead.\n    at file://${currentFileInfo.filePath}:${node.loc.start.line}:${node.loc.start.column}`);
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
            // Prepare to update the global view of scoped CSS in this file
            //

            currentFileInfo = getCssOriginInfo(this.filename)

            if (currentFileInfo && !currentFileInfo.isStale())
            {
                //
                // We have already processed this file since it was last modified
                //

                file.path.stop();
                return;
            }

            // log(`plugin-scoped-css: ${this.filename}`);
            
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
                    
                    // currentFileInfo.jsPathsWithCssAttributes.add(nodePath.parentPath);
                    currentElementHasCss = true;
                },

                JSXOpeningElement:
                {
                    exit(nodePath)
                    {
                        // if (!currentFileInfo.jsPathsWithCssAttributes.has(nodePath))
                        if (!currentElementHasCss)
                            return;
                        
                        // currentFileInfo.jsPathsWithCssAttributes.delete(nodePath);
                        currentElementHasCss = false;

                        //
                        // This JSXOpeningElement has at least one CSS attribute.
                        //
                        // For each, convert to a class name to add to the className attribute,
                        // if present. More than one className attribyte is invalid, but in this
                        // case the last one 'wins').
                        //

                        const attributes = nodePath.node.attributes;
                        const pathsToRemove = [];
                        let classNamePath;
                        
                        attributes.forEach(
                            (attribute, i) =>
                            {
                                // Skip exotic attributes like the JSXSpreadAttribute
                                if (attribute.type != 'JSXAttribute')
                                    return;

                                if (attribute.name.name == 'className')
                                {
                                    classNamePath = nodePath.get('attributes.' + i);
                                    return;
                                }
                                
                                if (attribute.name.name == 'css')
                                {
                                    //
                                    // Obtain the scoped CSS code and determine which CSS class should replace it.
                                    //
                                    
                                    const scopedCss = getNodeStringValue(attribute.value);
                                    if (scopedCss === undefined)
                                        throw nodePath.buildCodeFrameError(`Unhandled css attribute of type: ${attribute.value.type} in: ${generate(attribute.value).code}`);

                                    // We'll want to remove the CSS attribute later
                                    pathsToRemove.push(nodePath.get('attributes.' + i));
                                    
                                    const cssClassName = scopedCssSet.getClassName(scopedCss);
                                    if (!cssClassName)
                                        return;
                                    
                                    currentFileInfo.referencedClassNames.add(cssClassName);
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
                            // produce a new string with the additional CSS class names appended.
                            //
                            // If not, replace with code that will append the class names at runtime.
                            //

                            const value = classNamePath.node.value;
                            const existingClassNames = getNodeStringValue(value);

                            if (existingClassNames)
                            {
                                classNamePath.node.value =
                                    t.stringLiteral([existingClassNames, ...Array.from(currentFileInfo.referencedClassNames)].join(' '));
                            }
                            else if (t.isJSXExpressionContainer(value))
                            {
                                classNamePath.node.value =
                                    t.binaryExpression(
                                        '+',
                                        value.expression,
                                        t.stringLiteral(' ' + Array.from(currentFileInfo.referencedClassNames).join(' ')));
                            }
                            else
                                throw nodePath.buildCodeFrameError(`Unhandled className attribute of type: ${value.type} in: ${generate(value).code}`);
                        }
                        else
                        {
                            //
                            // No existing className attribute on this JSX node, add one with our generated classes.
                            //

                            const classNameAttribute = t.jsxAttribute(t.jsxIdentifier("className"), t.stringLiteral(Array.from(currentFileInfo.referencedClassNames).join(' ')));
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
