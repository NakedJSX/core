
//
// Development mode injected script providing auto refresh services.
//

(function()
{
    if (navigator.userAgent.indexOf("Chrome-Lighthouse") != -1)
        return;

    const reconnectionDelayMsMax = 60 * 1000;

    let reconnectionDelayMs = 0;

    function connect()
    {
        const idleUrl = `/nakedjsx:/idle?path=${encodeURIComponent(location.pathname)}`;

        console.log(`Connecting to development server on ${idleUrl}`);

        fetch(idleUrl)
            .then((result) => result.json())
            .then(
                (result) =>
                {
                    reconnectionDelayMs = 0;

                    switch (result.action)
                    {
                        case 'reload':
                            location.reload();
                            return; // break would briefly and pointlessly reconnect

                        default:
                            console.log('Did not understand dev server idle response: ' + JSON.stringify(result));
                    }

                    connect();
                })
            .catch(
                (error) =>
                {
                    reconnectionDelayMs = Math.min(reconnectionDelayMs + 1000, reconnectionDelayMsMax);

                    console.error(error);
                    setTimeout(connect, reconnectionDelayMs);
                });
    }

    connect();
})();