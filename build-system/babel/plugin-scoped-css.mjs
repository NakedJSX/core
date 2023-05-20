import fs from 'node:fs';

import { err } from '../util.mjs';

// babel plugin implementation
export default function(babel, options)
{
    const t = babel.types;

    const { scopedCssSet } = options;

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
        visitor:
            {
                CallExpression(nodePath, pluginPass)
                {
                    const callee = nodePath.node.callee;

                    if (callee.type !== 'Identifier' || callee.name !== '__nakedjsx_create_element')
                        return;

                    //
                    // It's a call to __nakedjsx_create_element(tagName, props, ...children).
                    // Do the props contain "css": ... ?
                    //

                    if (nodePath.node.arguments[1].type !== 'ObjectExpression')
                        return;
                    
                    const objectPath        = nodePath.get('arguments.1');
                    const propsPath         = objectPath.get('properties');
                    const cssPropPath       = propsPath.find(prop => prop.node.key.name === 'css');
                    const classNamePropPath = propsPath.find(prop => prop.node.key.name === 'className');
                    
                    if (!cssPropPath)
                        return;
                    
                    //
                    // This call to JSX.CreateElement() has a prop named 'css'.
                    // It's time to convert this scoped CSS into a class prop.
                    //

                    const scopedCss = getNodeStringValue(cssPropPath.node.value);

                    // Remove the css prop no matter what
                    cssPropPath.remove();

                    if (!scopedCss)
                        return;

                    const cssClassName = scopedCssSet.getClassName(scopedCss);
                    if (!cssClassName)
                        return;

                    //
                    // And now append / add the className prop
                    //

                    if (classNamePropPath)
                    {
                        const classNames = `${cssClassName} ${getNodeStringValue(classNamePropPath.node.value)}`;
                        classNamePropPath.node.value = t.stringLiteral(classNames);
                    }
                    else
                    {
                        const classNameProp = t.objectProperty(t.identifier("className"), t.stringLiteral(cssClassName));
                        objectPath.pushContainer('properties', classNameProp);
                    }
                }
            }
    };
};
