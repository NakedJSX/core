//
// Wraps an entire program in an Immediately Invoked Function Expression (IIFE)
//

export default function(babel)
{
    const t = babel.types;

    return {
        visitor:
            {
                Program:
                {
                    exit(nodePath)
                    {
                        // Backup the existing statements
                        const statements = [...nodePath.node.body];
                        
                        // Then remove them from the lop level scope
                        for (let statementPath of nodePath.get('body'))
                            statementPath.remove();
                        
                        // Now create an iife, add the statements to it, then add the iife to the program body
                        nodePath.pushContainer(
                            'body',
                            t.expressionStatement(
                                t.callExpression(
                                    t.functionExpression(
                                        null,
                                        [],
                                        t.blockStatement(statements)),
                                    [])
                                )
                            );
                    }
                }
            }
        };
};
