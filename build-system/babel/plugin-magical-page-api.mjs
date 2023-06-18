import { default as generator } from '@babel/generator'
const generate = generator.default;

import { uniqueGenerator } from '../util.mjs';

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
// 3. Inject a caching later around JSX passed to Page.Memo()
//
//     

export default function(babel)
{
    const t = babel.types;

    return {
        visitor:
            {
                Program(nodePath)
                {
                    //
                    // We wamt to make sure that any JSX code passed to
                    // client JS is not first compliled for page JS.
                    //
                    // Since babel plugin order is complex,
                    // and we want to guarantee that this plugin
                    // has completed before the page JS JSX transform,
                    // we immediately traverse the enture program.
                    //

                    let internalApiImported = false;

                    let pageApiImportDeclaration;
                    let importedPageIdentifier;
                    
                    const memoKeyGenerator = uniqueGenerator('__nakedjsx_memo_', '__');

                    nodePath.traverse(
                        {
                            JSXAttribute(nodePath)
                            {
                                // Catch attempts to set magic props
                                if (nodePath.node.name.name === 'context')
                                    throw nodePath.buildCodeFrameError(`Manually setting reserved 'context' prop is not allowed`);
                                
                                if (nodePath.node.name.name === 'children')
                                    throw nodePath.buildCodeFrameError(`Manually setting reserved 'children' prop is not allowed`);
                            },

                            ImportDeclaration(nodePath)
                            {
                                if (nodePath.node.source.value !== '@nakedjsx/core/page')
                                    return;

                                for (const specifer of nodePath.node.specifiers)
                                {
                                    if (specifer.type !== 'ImportSpecifier')
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

                                    //
                                    // We also automatically import the __nakedjsx_page_internal__ api if needed. To do that,
                                    // we'll need a reference to this node later.
                                    //

                                    pageApiImportDeclaration = nodePath;

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

                                // if (callee.property.name === 'Memo')
                                // {
                                //     if (!internalApiImported)
                                //     {
                                //         pageApiImportDeclaration.node.specifiers.push(t.importSpecifier(t.identifier('__nakedjsx_page_internal__'), t.identifier('__nakedjsx_page_internal__')));
                                //         internalApiImported = true;
                                //     }

                                //     handleMemo(nodePath);
                                //     return;
                                // }
                            }
                        })
                    
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

                    /**
                     * 
                     */
                    function handleMemo(memoNodePath)
                    {
                        //
                        // If a cache key has not been directly provided,
                        // we attempt to generate one from dynamic expressions
                        // within the JSX.
                        //

                        const cacheKeyNode =
                            memoNodePath.node.arguments.length > 1
                                ? memoNodePath.node.arguments[1]
                                : createMemoKeyNode(memoNodePath);

                        //
                        // Replace the Page.Memo() call with code that interacts with 
                        // the memo cache for this build of this page. Crucially, the
                        // JSX passed to Page.Memo() is not evaluated unless the cache
                        // does not contain a value for the key.
                        //

                        const cacheId = memoKeyGenerator.next().value;
                        
                        memoNodePath.replaceWith(
                            t.callExpression(
                                t.arrowFunctionExpression(
                                    [t.identifier('key')],                                    
                                    t.logicalExpression(
                                        '??',
                                        t.callExpression(
                                            t.memberExpression(
                                                t.identifier('__nakedjsx_page_internal__'),
                                                t.identifier('memoCacheGet')),
                                            [t.stringLiteral(cacheId), t.identifier('key')]),
                                        t.callExpression(
                                            t.memberExpression(
                                                t.identifier('__nakedjsx_page_internal__'),
                                                t.identifier('memoCacheSet')),
                                            [t.stringLiteral(cacheId), t.identifier('key'), memoNodePath.node.arguments[0]])
                                        )
                                    ),
                                [cacheKeyNode]
                                )
                            );

                        // console.log(memoNodePath.toString());
                    }

                    function createMemoKeyNode(memoNodePath)
                    {
                        //
                        // Try to generate a key from any dynamic elements used within the JSX.
                        // Only do this for very simple cases for now, otherwise generate a
                        // compiler error.
                        //

                        const uniqueMemberExpressions   = new Set();
                        const uniqueIdentifiers         = new Set();
                        const automaticKeyNodes         = [];

                        memoNodePath.get('arguments.0').traverse(
                            {
                                JSXExpressionContainer(jsxExpressionNodePath)
                                {
                                    //
                                    // The JSX contains {/* something */}
                                    //
                                    // We're interested in any expressions that might vary at runtime,
                                    // so that the runtime value can form part of the cache key.
                                    //
                                    // Have to be very careful with this so for now just support
                                    // simple things like 'obj.member' or 'identifier'.
                                    //
                                    // There are likely other things that can safely be ignored
                                    // or added to the cache key. CallExpression would be interesting
                                    // to support but very complex given that it might be conditionally
                                    // called, and that the result would have to be passed to the original
                                    // expression to avoid calling it twice.
                                    //

                                    function makeStringify(nodeToStringify)
                                    {
                                        return  t.callExpression(
                                                    t.memberExpression(t.identifier('JSON'),t.identifier('stringify')),
                                                    [nodeToStringify]
                                                    );
                                    }

                                    jsxExpressionNodePath.traverse(
                                        {
                                            enter(nodePath)
                                            {
                                                // console.log(nodePath.type);
                                                // if (!t.isTemplateElement(nodePath))
                                                //     console.log(nodePath.toString());

                                                if (    t.isTemplateLiteral(nodePath)
                                                    ||  t.isTemplateElement(nodePath)
                                                    ||  t.isMemberExpression(nodePath)
                                                    ||  t.isIdentifier(nodePath)
                                                    ||  t.isLogicalExpression(nodePath)
                                                    ||  t.isUnaryExpression(nodePath)
                                                    ||  t.isConditional(nodePath)
                                                    ||  t.isJSX(nodePath)
                                                    ||  t.isSequenceExpression(nodePath)
                                                    ||  t.isNumericLiteral(nodePath)
                                                    ||  t.isStringLiteral(nodePath)
                                                    )
                                                {
                                                    return;
                                                }

                                                throw nodePath.buildCodeFrameError(`Cannot currently build an automatic Page.Memo() cache key from this expression`);
                                            },

                                            MemberExpression(nodePath)
                                            {
                                                const code = nodePath.toString();

                                                if (!uniqueMemberExpressions.has(code))
                                                {
                                                    uniqueMemberExpressions.add(code);
                                                    automaticKeyNodes.push(makeStringify(t.cloneDeep(nodePath.node)));
                                                }

                                                nodePath.skip();
                                            },

                                            Identifier(nodePath)
                                            {
                                                const code = nodePath.toString();

                                                if (!uniqueIdentifiers.has(code))
                                                {
                                                    uniqueIdentifiers.add(code);
                                                    automaticKeyNodes.push(makeStringify(t.cloneDeep(nodePath.node)));
                                                }
                                            }
                                        });
                                }
                            });

                        // The generated key is of the form [<dynamic elements>].join()
                        return  t.callExpression(
                                    t.memberExpression(
                                        t.arrayExpression(automaticKeyNodes),
                                        t.identifier('join')
                                        ),
                                    []);
                    }
                }
            }
        };
}