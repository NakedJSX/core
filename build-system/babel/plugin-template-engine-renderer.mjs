//
// NakedJSX pages are normally generated as an import() side effect.
// In template engine mode, we need to wrap page generation in an
// exported and resuable function.
//

export default function(babel)
{
    const t = babel.types;

    return {
        visitor:
            {
                Program(nodePath)
                {
                    const body          = nodePath.get('body');
                    const statements    = body.filter(statement => !statement.isImportDeclaration());
                    const nodes         = [];

                    for (const statement of statements)
                    {
                        const node = statement.node;
                        const { leadingComments, trailingComments } = node;

                        // Bizarely, if we don't detach comments like this the comments remain in program after statement.remove()
                        node.leadingComments    = null;
                        node.trailingComments   = null;

                        statement.remove();

                        // Restore the comment links so they are added when the node is
                        node.leadingComments    = leadingComments;
                        node.trailingComments   = trailingComments;

                        nodes.push(node);
                    }

                    const res = nodePath.pushContainer(
                        'body',
                        t.exportNamedDeclaration(
                            t.functionDeclaration(
                                t.identifier('render'),
                                [t.identifier('__context')],
                                t.blockStatement(nodes),
                                false,  // generator
                                true    // async, needed for Page.Render()
                                )
                            )
                        );
                }
            }
        };
};
