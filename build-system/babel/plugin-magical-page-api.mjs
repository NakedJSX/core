//
// 1. Ensure calls to async Page functions are awaited.
//
//     Without this, it's too easy for users to forget to await Page.Render().
//     This creates instability which would be blamed on NakedJSX.
//
//     It also keeps the API nice and clean, and the approach allows us to make
//     other calls transparently async later without breaking existing projects.
//
// 2. Where possible, convert code passed to Page.AppendJS to a string
//
//     Code located inside page JS and then added as client JS is first compiled
//     for use in a page, then compiled again for the client. Although this works,
//     the downside is that JSX code has already been transformed into __nakedjsx__
//     calls by the time the client build process happens, and so the original
//     JSX is not visible in a browser debugger, only the __nakedjsx__ calls.
//
//     By preprocessing this code to a string, which Page.AppendJS also accepts,
//     we bypass the first page JS compilation step for that code.
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

                    if (callee.property.name === 'AppendJs')
                    {
                        const argumentsPath = nodePath.get('arguments');
                        if (argumentsPath.length != 1)
                            throw nodePath.buildCodeFrameError("Page.AppendJs currently only supports one argument");
                        
                        const argumentPath = nodePath.get('arguments.0');
                        const { node: argumentNode } = argumentPath;

                        if (argumentPath.node.type === 'Identifier')
                        {
                            //
                            // Page.AppendJs() has been passed a function or a variable variable.
                            //
                            // If we can unambigiously find its value, and that
                            // value is a function, replace it with a string
                            // containing the source code of that function.
                            //

                            const binding = nodePath.scope.getBinding(argumentNode.name);
                            if (binding?.path?.type === 'FunctionDeclaration')
                            {
                                //
                                // A named function has been passed by name.
                                // Replace with a string containing the source code for that function.
                                //

                                nodePath.node.arguments = [t.stringLiteral(binding.path.toString())];
                            }

                            //
                            // We could add support for const variables that point to functions
                            // but it seems a bit pointless when the function could just be passed directly.
                            //

                            return;
                        }

                        if (argumentNode.type === 'FunctionExpression' && argumentNode.id)
                        {
                            //
                            // Page.AppendJs() has been passed a named function in full:
                            //
                            //     Page.AppendJs(function namedFunction() { ... });
                            //
                            // We replace this with a string containing the source code of the function.
                            //

                            nodePath.node.arguments = [t.stringLiteral(argumentPath.toString())];

                            return;
                        }

                        if (argumentNode.type === 'FunctionExpression' || argumentNode.type === 'ArrowFunctionExpression')
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

                            const conciseBodyJs =
                                argumentPath
                                    .get('body')
                                    .get('body')
                                    .map(statement => statement.toString())
                                    .join('');

                            nodePath.node.arguments = [t.stringLiteral(conciseBodyJs)];
                        }                     
                    }
                }
            }
        };
};
