import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http'
import { URL } from 'node:url';

import { log, err } from './util.mjs';

//
// Super simple long-poll dev server.
//
// Used to notify a client that a uri path has been updated.
//

export class DevServer
{
    #clientJsFile;

    #serverRoot;
    #serverUrl;

    #idleClients = new Map(); // page url -> [ idle http response ]

    constructor({ serverRoot, clientJsFile })
    {
        if (!fs.existsSync(serverRoot))
            throw new Error(`serverRoot ${serverRoot} does not exist`);

        if (!fs.existsSync(clientJsFile))
            throw new Error(`clientJsFile ${clientJsFile} does not exist`);

        this.#serverRoot    = serverRoot;
        this.#clientJsFile  = clientJsFile;
    
        //
        // Start a local dev web server
        //        

        const defaultServerPort = 8999;
        let serverPort          = defaultServerPort;

        const server = http.createServer(this.#handleRequest.bind(this));
        server.on(
            'error',
            (e) =>
            {
                if (e.code !== 'EADDRINUSE')
                    throw e;

                server.close();

                if (--serverPort <= defaultServerPort - 10)
                {
                    fatal(`Ports ${defaultServerPort} - ${serverPort + 1} in use, giving up.`);
                }
                
                console.error(`* Port ${serverPort + 1} in use, trying ${serverPort}`);
                server.listen(serverPort);
            });
        server.on(
            'listening',
            () =>
            {
                this.#serverUrl = `http://localhost:${serverPort}`;
                log(`Development web server started\n`);
            });
        server.listen(serverPort);
    }

    get serverUrl()
    {
        return this.#serverUrl;
    }

    ////

    async #handleRequest(req, response)
    {
        const url       = new URL(req.url, 'http://localhost/');
        const pathname  = url.pathname;

        log(`HTTP request for ${req.url}`);

        if (pathname.startsWith('/nakedjsx:/'))
            return this.#handleDevRequest(req, response, url);

        // For non dev requests, ensure we end the response
        try
        {
            let file;

            if (pathname.endsWith('/'))
                file = `${this.#serverRoot}${pathname}index.html`;
            else
                file = `${this.#serverRoot}${pathname}`;

            async function resolve(testfile, onResolved, onError)
            {
                try
                {
                    const resolvedFile  = await fsp.realpath(testfile);
                    const stat          = await fsp.stat(resolvedFile);

                    if (stat.isFile())
                        await onResolved(resolvedFile);
                    else
                        await onError(new Error(`Not a file: ${resolvedFile}`));
                }
                catch(error)
                {
                    await onError(error);
                }
            }

            await resolve(
                file,
                async (resolvedFile) => this.#serveFile(response, resolvedFile),
                async (outerError) =>
                {
                    // If the bad path included a file extension, nothing more to try
                    if (path.extname(file))
                        return this.#respondUtf8(response, 404, 'text/plain', outerError.toString());
                    
                    // Try the same path but plop a .html on the end of it.
                    await resolve(
                        file + '.html',
                        async (resolvedFile) => this.#serveFile(response, resolvedFile),
                        async (innerError) => this.#respondUtf8(response, 404, 'text/plain', outerError.toString())
                        );
                });
        }
        catch(error)
        {
            err(error.stack);
        }
        finally
        {
            response.end();
        }
    }

    #respondUtf8(response, code, contentType, content, headers = {})
    {
        response.writeHead(
            code,
            {
                'Content-Type': contentType,
                ...headers
            });
        response.end(content, 'utf-8');
    }

    #respondBinary(response, code, contentType, content, headers = {})
    {
        response.writeHead(
            code,
            {
                'Content-Type':     contentType,
                'Content-Length':   content.length,
                ...headers
            });
        response.end(content);
    }

    #getFileType(filename)
    {
        //
        // These MIME types and maxAge values are used by the dev server only.
        //

        const ext = path.extname(filename);
        const contentTypes =
            {
                '.html':    { type: 'text/html',        maxAge: -1  },
                '.js':      { type: 'text/javascript',  maxAge: -1  }, // Needs to be -1 until a hash is put into /nakedjsx:/client.js request
                '.css':     { type: 'text/css',         maxAge: 300 },
                '.svg':     { type: 'image/svg+xml',    maxAge: 300 },
                '.webp':    { type: 'image/webp',       maxAge: 300 },
                '.png':     { type: 'image/png',        maxAge: 300 },
                '.jpg':     { type: 'image/jpeg',       maxAge: 300 },
                '.jpeg':    { type: 'image/jpeg',       maxAge: 300 },
            };

        return contentTypes[ext] || { type: 'application/octet-stream', maxAge: -1 };
    }

    async #serveFile(response, filepath)
    {
        // log(` (${filepath})`);

        if (!filepath.startsWith(this.#serverRoot) && filepath != this.#clientJsFile)
            return this.#respondUtf8(response, 404, 'text/plain');
        
        const type = this.#getFileType(filepath);

        let cacheControl;
        if (type.maxAge > 0)
            cacheControl = `public, max-age=${type.maxAge}, immutable`;
        else
            cacheControl = `max-age=-1`;
        
        try
        {
            const content = await fsp.readFile(filepath);
            this.#respondBinary(response, 200, type.type, content, { 'Cache-Control': cacheControl });
        }
        catch(error)
        {
            this.#respondUtf8(response, 500, 'text/plain', error.toString());
        }
    }

    ////

    #handleDevRequest(req, response, url)
    {
        const functionPath = url.pathname.substring(url.pathname.indexOf(':') + 1);
        
        switch(functionPath)
        {
            case '/client.js':
                this.#serveFile(response, this.#clientJsFile);
                break;

            case '/idle':
                let idlePath = url.searchParams.get('path');

                //
                // Normalise idle path
                //
                
                if (idlePath.endsWith('.html'))
                    idlePath = idlePath.substring(0, idlePath.length - '.html'.length);
                
                if (idlePath.endsWith('/index'))
                    idlePath = idlePath.substring(0, idlePath.length - 'index'.length);

                if (idlePath === '')
                    pathPath = '/';
                
                log(`Client is watching ${idlePath}`);

                const idleClients = this.#idleClients.get(idlePath);
                if (idleClients)
                    idleClients.push(response);
                else
                    this.#idleClients.set(idlePath, [ response ]);

                response.writeHead(
                    202,
                    {
                        'Content-Type': 'application/json'
                    });
                response.flushHeaders();

                break;

            default:
                this.#respondUtf8(response, 404, 'text/plain', '');
        }
    }

    onUriPathUpdated(uriPath)
    {
        const idleClients = this.#idleClients.get(uriPath);
        if (idleClients)
        {
            this.#idleClients.delete(uriPath);

            for (let response of idleClients)
                response.end(JSON.stringify({ action: 'reload' }), 'utf-8');
        }
    }
}