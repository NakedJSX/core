//
// Ensure calls to async Page functions are awaited.
//
// Without this, it's too easy for users to forget to await Page.Render().
// This creates instability which would be blamed on NakedJSX.
//
// It also keeps the API nice and clean, and the approach allows us to make
// other calls transparently async later without breaking existing projects.
//

export default function(babel)
{
    const t = babel.types;

    let awaiting;
    let importedPageIdentifier;

    return {
        visitor:
            {
                Program(nodePath, pluginPass)
                {
                    awaiting                 = false;
                    importedPageIdentifier   = undefined;
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

                AwaitExpression:
                {
                    enter(nodePath)
                    {
                        awaiting = true;
                    },

                    exit(nodePath)
                    {
                        awaiting = true;
                    }
                },

                CallExpression(nodePath, pluginPass)
                {
                    if (awaiting || !importedPageIdentifier)
                        return;
                    
                    const callee = nodePath.node.callee;
                    if (callee.type !== 'MemberExpression')
                        return;

                    //
                    // Not awaiting obj.prop() - should we be?
                    //

                    if (callee.object.name !== importedPageIdentifier)
                        return;
                    
                    //
                    // It's Page.<something>()
                    //

                    if (callee.property.name === 'Render')
                    {
                        //
                        // Wrap the non-awaited Page.Render(...) with an AwaitExpression
                        //

                        nodePath.replaceWith(t.awaitExpression(nodePath.node));
                    }
                }
            }
        };
};
