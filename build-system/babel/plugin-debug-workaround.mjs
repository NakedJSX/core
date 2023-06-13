//
// NakedJSX pages are rendered via a dynamic import().
//
// Unfortunately, when debugging under vscode (and likely other debuggers)
// execution of the import()ed script does not block until sourcemaps
// have been processed by vscode, which results in early breakpoints
// not functioning.
//
// Until this problem is solved generically, attempt to work around
// by introducing a small delay to the beginning of every generated
// script.
//
// This doesn't fix the race condition, just shifts the race.
// On an otherwise idle M1 CPU a setTimeout of 2ms appears to work.
// A much larger value is chosen to try and make this work no matter
// the CPU (or load). Ultimately this sucks but is better than nothing.
//
// https://github.com/microsoft/vscode-js-debug/issues/1510
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
                    // Place a delay at the start of the program (should only be used if debugger attached).
                    // This is to work around issues with breakpoints in dynamically import()ed files.
                    //
                    // See: https://github.com/microsoft/vscode-js-debug/issues/1510#issuecomment-1560510140
                    //

                    const delayCode =
                        t.arrowFunctionExpression(
                            [t.identifier('resolve')],
                            t.callExpression(
                                t.identifier('setTimeout'),
                                [t.identifier('resolve'), t.numericLiteral(25)]
                                )
                            );

                    const awaitExpression =
                        t.expressionStatement(
                            t.awaitExpression(
                                t.newExpression(
                                    t.identifier('Promise'),
                                    [delayCode]
                                    )
                                )
                            );
                    
                    t.addComments(
                        awaitExpression,
                        'leading',
                        [
                            { type: "CommentLine", value: ' HACK: Attached debugger detected at build time, give vscode time to connect breakpoints for dynamic import ...' },
                            { type: "CommentLine", value: '  see: https://github.com/microsoft/vscode-js-debug/issues/1510#issuecomment-1560510140' }
                        ]);
        
                    nodePath.unshiftContainer('body', awaitExpression);
                },
            }
        };
};
