import { default as generator } from '@babel/generator'
const generate = generator.default;

//
// 1. Ensure calls to async Page functions are awaited.
//
//     Without this, it's too easy for users to forget to await Page.Render().
//     This creates instability which would be blamed on NakedJSX.
//
//     It also keeps the API nice and clean, and the approach allows us to make
//     other calls transparently async later without breaking existing projects.
//
// 2. Convert JavaScript code passed directly to Page.AppendJs() to a string.
//
//     Get syntax highlighting for snippets of page JavaScript code passed to
//     Page.AppendJs() (vs using a string). The resulting string of code is later
//     compiled for inclusion in the final page for the browser to run.
//

export default function(babel)
{
    const t = babel.types;

    let importedPageIdentifier;

    return {
        visitor:
            {
                Program(nodePath, pluginPass)
                {
                    importedPageIdentifier = undefined;
                },

                ImportDeclaration(nodePath, pluginPass)
                {
                    for (const specifer of nodePath.node.specifiers)
                    {
                        if (specifer.type !== 'ImportSpecifier')
                            continue;
                        
                        if (nodePath.node.source.value !== '@nakedjsx/core/page')
                            continue;

                        if (specifer.imported.name !== 'Page')
                            continue;

                        //
                        // This program has imported { Page }, or maybe { Page as Something }, from '@nakedjsx/core/page'
                        //
                        // We are making the assumption that Render() will be called directy on this object,
                        // but people doing fancy things can call await themselves.
                        //

                        importedPageIdentifier = specifer.local.name;
                        break;
                    }
                },

                CallExpression(nodePath, pluginPass)
                {
                    if (!importedPageIdentifier)
                        return;
                    
                    const callee = nodePath.node.callee;
                    if (callee.type !== 'MemberExpression')
                        return;

                    if (callee.object.name !== importedPageIdentifier)
                        return;
                    
                    //
                    // It's Page.<something>()
                    //

                    if (callee.property.name === 'Render')
                    {
                        if (nodePath.parentPath.type !== 'AwaitExpression')
                        {
                            //
                            // Wrap the non-awaited Page.Render(...) with an AwaitExpression
                            //

                            nodePath.replaceWith(t.awaitExpression(nodePath.node));
                        }

                        return;
                    }

                    if (callee.property.name === 'AppendJs' || callee.property.name === 'AppendJsIfNew')
                    {
                        handleAppendJs(nodePath);
                        return;
                    }
                }
            }
        };

    /**
     * All arguments passed to Page.AppendJs() / Page.AppendJsIfNew() are converted
     * to strings containing JavaScript source code.
     */
    function handleAppendJs(nodePath)
    {
        const resultingJs = nodePath.get('arguments').map(handleAppendJsArgument.bind(null, nodePath.scope));

        nodePath.node.arguments = resultingJs;
    }

    function handleAppendJsArgument(scope, path)
    {
        if (path.isStringLiteral())
            return path.node;
        
        if (path.isTemplateLiteral())
            return path.node;

        if (path.isFunctionExpression() && path.node.id)
        {
            //
            // Page.AppendJs() has been passed a named function in full:
            //
            //     Page.AppendJs(function namedFunction() { ... });
            //
            // We replace this with a string containing the source code of the function.
            //
            // Any more FunctionExpressions we assume to be anon
            //

            return t.stringLiteral(path.toString());
        }

        if (path.isFunctionExpression() || path.isArrowFunctionExpression())
        {
            //
            // Page.AppendJs() has been passed an anon or arrow function:
            //
            //     Page.AppendJs(function() { ... });
            //     Page.AppendJs(() => { ... });
            //
            // In either case it doesn't make sense to add either of these
            // to the top level scope as-is as they'd never be invoked.
            //
            // However, we can make use of this syntax to add the whole body
            // of the function to the top level scope.
            //

            const body = path.get('body');

            if (body.isBlockStatement())
            {
                const conciseBodyJs =
                    body.get('body')
                        .map(statement => statement.toString())
                        .join('');

                return t.stringLiteral(conciseBodyJs);
            }
            else
                // probably something like () => someFunc()
                return t.stringLiteral(body.toString());
        }

        if (path.isIdentifier())
        {
            //
            // Page.AppendJs() has been passed a function or variable identifier.
            //
            // If we can unambigiously find its value, and that
            // value is a function, replace it with a string
            // containing the source code of that function.
            //

            const binding = scope.getBinding(path.node.name);

            if (!binding)
                throw path.buildCodeFrameError(`Something isn't right with this, please let the NakedJSX team know what you're doing`);

            if (binding.path.isFunctionDeclaration())
            {
                //
                // A named function has been passed by its identifier.
                // Replace with a string containing the source code for that function.
                //

                return t.stringLiteral(binding.path.toString());
            }

            //
            // Check for a const that points to an anon or arrow function.
            //
            // This allows code like:
            //
            //     const Tag =
            //         () =>
            //         <p>
            //            some tag
            //         </p>
            //
            // or:
            //
            //     const Tag =
            //         function()
            //         {
            //             return <p>some tag</p>
            //         }
            //
            // To be passed to client JS using:
            //
            //     Page.AppendJs(Tag);
            //

            if (binding.path.isVariableDeclarator())
            {
                if (!path.isConstantExpression())
                    throw path.buildCodeFrameError(`Identifiers passed to Page.AppendJs must be const.`);
                
                const value = binding.path.get('init');

                if (value.isArrowFunctionExpression() || value.isFunctionExpression())
                    return t.stringLiteral(generate(t.variableDeclaration('const', [binding.path.node])).code);
                else
                    throw path.buildCodeFrameError(`Identifiers passed to Page.AppendJsx must be initialised with a function`);
            }
        }
        
        // By default, just convert to the code to a string representation and return it as a StringLiteral node
        return t.stringLiteral(path.toString());
    }
}