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
                    // await new Promise(resolve => setTimeout(resolve, 25));
                    //

                    const promiseImpl =
                        t.arrowFunctionExpression(
                            [t.identifier('resolve2')],
                            t.callExpression(
                                t.identifier('setTimeout'),
                                [t.identifier('resolve2'), t.numericLiteral(25)]
                                )
                            );
                    
                    nodePath.unshiftContainer(
                        'body',
                        t.expressionStatement(
                            t.awaitExpression(
                                t.newExpression(
                                    t.identifier('Promise'),
                                    [promiseImpl]
                                    )
                                )
                            )
                        );
                },
            }
        };
};
