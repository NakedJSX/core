import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import http from 'node:http'
import { URL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import chokidar from 'chokidar';
import { minify } from 'terser';
import { rollup } from 'rollup';
import { babel, getBabelOutputPlugin } from '@rollup/plugin-babel';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import { nodeResolve } from '@rollup/plugin-node-resolve';

import { collateCss, getCssClassName } from './babel/plugin-scoped-css.mjs';
import { loadCss } from './babel/css-loader.mjs';
import { mapCachePlugin } from './rollup/plugin-map-cache.mjs';
import { log, warn, err, abort  } from './util.mjs';

const nakedJsxSourceDir = path.dirname(fileURLToPath(import.meta.url));

//
// We are using createRequire(..).resolve to allow babel to find the plugin under yarn pnp.
//

const resolveModule = createRequire(import.meta.url).resolve;

export class NakedJSX
{
    #developmentMode;
    #developmentModeClientJs;

    #srcDir;
    #dstDir;
    #dstAssetDir;

    #commonCssFile;
    #commonCss;
    #browserslistTargetQuery;

    #assetImportPlugins = new Map();

    #pathMapJs          = {};
    #pathMapAsset       = {};
    #definitions        = {};

    #started            = false;
    #initialising       = true;
    #building           = false;
    #buildStartTime;
    
    #pages              = {};
    #pagesToBuild       = new Set();
    #pagesInProgress;
    #pagesWithErrors;

    #watcher;
    #watchFiles         = new Map(); // filename -> Set<page>

    #terserCache        = new Map();
    #babelInputCache    = new Map();
    #babelOutputCache   = new Map();
    #importLoadCache    = new Map();
    #nodeResolveCache   = new Map();
    #commonjsCache      = new Map();
    #jsonCache          = new Map();

    #idleClients        = new Map(); // page url -> [ idle http response ]

    constructor(
        {
            pagesRootDir,
            outputDir,
            commonCssFile           = undefined,
            importMapping           = {},
            browserslistTargetQuery = 'defaults',
            assetImportPlugins      = []
        })
    {
        log('NakedJSX initialising');

        if (!fs.existsSync(pagesRootDir))
            throw new Error(`Pages root dir ${pagesRootDir} does not exist`);

        if (!fs.existsSync(outputDir))
            fs.mkdirSync(outputDir);
        
        this.#srcDir                    = fs.realpathSync(pagesRootDir);
        this.#dstDir                    = fs.realpathSync(outputDir);
        this.#dstAssetDir               = this.#dstDir + '/asset';
        this.#commonCssFile             = commonCssFile ? fs.realpathSync(commonCssFile) : undefined;
        this.#browserslistTargetQuery   = browserslistTargetQuery;

        //
        // Process import mappings
        //

        for (let [alias, value] of Object.entries(importMapping))
        {
            switch(value.type)
            {
                case 'source':
                    this.#pathMapJs[alias] = { ...value };
                    break;

                case 'asset':
                    this.#pathMapAsset[alias] = { ...value };
                    break;

                case 'definition':
                    this.#definitions[alias] = { ...value };
                    break;

                default:
                    throw Error(`Unsupported mapping type ${value.type}`);
            }
        }

        //
        // Register asset import plugins
        //

        for (let pluginRegistration of assetImportPlugins)
            pluginRegistration(
                (plugin) =>
                {
                    log(`Registering asset import plugin: ${plugin.type}`);
                    this.#assetImportPlugins.set(plugin.type, plugin);
                });

        //
        // Good to go, from here call either developmentMode() or build()
        //
    }

    /**
     * Start a development build and web server.
     */
    developmentMode()
    {
        if (this.#started)
            throw Error('NakedJSX already started');
        
        this.#started                   = true;
        this.#developmentMode           = true;
        this.#developmentModeClientJs   = fs.readFileSync(`${nakedJsxSourceDir}/dev-mode-client-injection.js`).toString();

        this.#startWebServer();
        this.#startWatchingFiles();

        //
        // Configure our shutdown handler if running in a terminal
        //

        if (process.stdin.isTTY)
        {
            process.stdin.setRawMode(true);
            process.stdin.setEncoding('utf8');
            process.stdin.on('readable',
                () =>
                {
                    var char = process.stdin.read(1);
                    if (!char)
                        return;
                    
                    switch (char.toLowerCase())
                    {
                        case 'x':
                            // wtf, there doesn't seem to be a close feature in the node http server.
                            process.exit();
                            break;
                    }
                });
            
            log(`*********************\n` +
                `* Press (x) to exit *\n` +
                `*********************\n`);
        }
    }

    /**
     * Perform a production build.
     */
    build()
    {
        if (this.#started)
            throw Error('NakedJSX already started');

        this.#started           = false;
        this.#developmentMode   = false;

        this.#startWatchingFiles();
    }
    
    ////////////////

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
                '.css':     { type: 'text/css',         maxAge: 300 },
                '.js':      { type: 'text/javascript',  maxAge: 300 },
                '.svg':     { type: 'image/svg+xml',    maxAge: 300 },
                '.webp':    { type: 'image/webp',       maxAge: 300 },
                '.png':     { type: 'image/png',        maxAge: 300 },
                '.jpg':     { type: 'image/jpeg',       maxAge: 300 },
                '.jpeg':    { type: 'image/jpeg',       maxAge: 300 },
            };

        return contentTypes[ext] || { type: 'application/octet-stream', maxAge: -1 };
    }

    #serveFile(response, filepath)
    {
        // log(` (${filepath})`);

        if (!filepath.startsWith(this.#dstDir))
            return this.#respondUtf8(response, 404, 'text/plain');
        
        const type = this.#getFileType(filepath);

        let cacheControl;
        if (type.maxAge > 0)
            cacheControl = `public, max-age=${type.maxAge}, immutable`;
        else
            cacheControl = `max-age=-1`;
        
        fsp.readFile(filepath)
            .then( content => this.#respondBinary(response, 200, type.type,    content, { 'Cache-Control': cacheControl }))
            .catch(error   => this.#respondUtf8(  response, 500, 'text/plain', error.toString()));
    }

    #handleDevRequest(req, response, url)
    {
        const functionPath = url.pathname.substring(url.pathname.indexOf(':') + 1);
        
        switch(functionPath)
        {
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

                break;

            default:
                this.#respondUtf8(response, 404, 'text/plain', '');
        }
    }

    #startWebServer()
    {
        //
        // Start a local dev web server
        //        

        const serverPort = 8999;
        const serverUrl = 'http://localhost:' + serverPort;
        const server = http.createServer(
            (req, response) =>
            {
                const url       = new URL(req.url, 'http://localhost/');
                const pathname  = url.pathname;

                log(`HTTP request for ${req.url}`);

                if (pathname.startsWith('/nakedjsx:/'))
                    return this.#handleDevRequest(req, response, url);

                let file;

                if (pathname.endsWith('/'))
                    file = `${this.#dstDir}${pathname}index.html`;
                else
                    file = `${this.#dstDir}${pathname}`;

                function resolve(testfile, onResolved, onError)
                {
                    fsp.realpath(testfile)
                        .then(
                            (resolvedFile) =>
                            {
                                fsp.stat(resolvedFile)
                                    .then(
                                        (stat) =>
                                        {
                                            if (stat.isFile())
                                                onResolved(resolvedFile);
                                            else
                                                onError(new Error(`Not a file: ${resolvedFile}`));
                                        })
                                    .catch((error) => onError(error));
                            })
                        .catch((error) => onError(error));
                }

                resolve(
                    file,
                    (resolvedFile) => this.#serveFile(response, resolvedFile),
                    (outerError) =>
                    {
                        if (path.extname(file))
                            this.#respondUtf8(response, 500, 'text/plain', outerError.toString());
                        else
                            resolve(
                                file + '.html',
                                (resolvedFile) => this.#serveFile(response, resolvedFile),
                                (innerError) => this.#respondUtf8(response, 500, 'text/plain', outerError.toString())
                                );
                    });
            });

        server.listen(serverPort);

        log(`Development web server started on ${serverUrl}`);
    }
     
    #startWatchingFiles()
    {
        log(`Build server starting\n` +
            `   input dir: ${this.#srcDir}\n` +
            `  output dir: ${this.#dstDir}\n`);

        //
        // Watcher dedicated to looking for new pages
        //
        
        this.#watcher =
            chokidar.watch(
                './**/*',
                {
                    cwd: this.#srcDir
                });
        this.#watcher.on('add',    filename => this.#considerNewPageFile(filename));
        this.#watcher.on('change', filename => this.#considerChangedPageFile(filename));
        this.#watcher.on('unlink', filename => this.#considerDeletedPageFile(filename));
        this.#watcher.on(
            'ready',
            () =>
            {
                log('\nREADY.\n');
                this.#initialising = false;
                this.#buildAll();
            });
    }

    #considerNewPageFile(filename)
    {
        //
        // A file has been discovered under #srcDir.
        //
        // It might new a new page, or a new browser script for an existing page.
        //

        const match = this.#matchPageJsFile(filename);
        if (!match)
            return;
        
        log(`Page ${match.uriPath} added ${filename}`);

        const page =
            this.#pages[match.uriPath] ||
            (this.#pages[match.uriPath] =
                {
                    outputDir: match.outputDir,
                    uriPath: match.uriPath,
                    htmlFile: match.htmlFile
                });

        this.#addPageFileMatch(match, page, filename);
    }

    #numPageStr(num)
    {
        return (num == 1) ? '1 page' : `${num} pages`;
    }

    async #considerChangedPageFile(filename)
    {
        log(`Changed file: ${filename}`);

        //
        // A file has under #srcDir has changed.
        //

        const fullPath      = await fsp.realpath(`${this.#srcDir}/${filename}`);
        const affectedPages = this.#watchFiles.get(fullPath);
        if (!affectedPages)
            return;
        
        log(`Changed file ${fullPath} affects ${this.#numPageStr(affectedPages.size)}`);
        
        this.#enqueuePageBuild(...affectedPages);
    }

    #considerDeletedPageFile(filename)
    {
        //
        // A file has under #srcDir has changed.
        //

        const match = this.#matchPageJsFile(filename);
        if (!match)
            return;
    
        log(`Page ${match.htmlFile} deleted ${match.type} file: ${filename}`);

        const page = this.#pages[match.uriPath];
        if (!page)
            throw new Error(`Page ${match.uriPath} not tracked for deleted file ${filename}?`);

        const fullPath = `${this.#srcDir}/${filename}`;

        if (match.type === 'html')
        {
            delete page.htmlJsFileIn;
        }
        else if (match.type === 'client')
        {
            delete page.clientJsFileIn;
        }
        else if (match.type === 'config')
        {
            delete page.configJsFile;
        }
        else
            throw new Error(`Bad page js file type ${match.type} for page ${match.uriPath}`);
        
        this.#enqueuePageBuild(page);
    }

    #matchPageJsFile(filename)
    {
        const pageEntryMatch    = /^(.*)-(client|html|config)\.js$/;
        const match             = filename.match(pageEntryMatch);

        if (match)
        {    
            const htmlFile  = path.basename(match[1] + '.html');
            const uriPath   = match[1] === 'index' ? '/' : ('/' + match[1]).replace(/\/index$/, '');
            const outputDir = path.resolve(`${this.#dstDir}/${path.dirname(match[1])}`);
            
            return {
                type: match[2],
                outputDir,
                uriPath,
                htmlFile
            };
        }
    }

    #addPageFileMatch(match, page, filename)
    {
        const fullPath = `${this.#srcDir}/${filename}`;

        if (match.type === 'html')
        {
            page.htmlJsFileIn       = fullPath;
            page.htmlJsFileOut    = `${this.#dstDir}/${filename}`;
        }
        else if (match.type === 'client')
        {
            page.clientJsFileIn     = fullPath;
        }
        else if (match.type === 'config')
        {
            page.configJsFile       = fullPath;
        }
        else
            throw new Error(`Bad page js file type ${match.type} for page ${match.uriPath}`);
        
        this.#enqueuePageBuild(page);
    }

    #enqueuePageBuild(...pages)
    {
        for (let page of pages)
        {
            this.#pagesToBuild.add(page);

            // Disconnect this page from watch file rebuilds for now
            for (let [, pages] of this.#watchFiles)
                pages.delete(page);
        }

        if (this.#initialising)
            return;

        if (!this.#building)
            this.#buildAll();
    }

    async #buildAll()
    {
        if (this.#initialising)
            abort('#buildAll called while initialising');

        if (this.#building)
            abort('#buildAll called while building');

        log(`Building ${this.#numPageStr(this.#pagesToBuild.size)} ...`);

        this.#buildStartTime    = new Date();
        this.#building          = true;

        if (this.#commonCssFile)
            this.#commonCss = loadCss((await fsp.readFile(this.#commonCssFile)).toString());
        else
            this.#commonCss = '';

        // This allows async events to safely queue up pages to build, during the build
        this.#pagesInProgress   = this.#pagesToBuild;
        this.#pagesToBuild      = new Set();
        this.#pagesWithErrors   = new Set();

        //
        // Start building.
        //

        const mkdirOptions = { recursive: true };
        fs.mkdirSync(this.#dstDir,      mkdirOptions);
        fs.mkdirSync(this.#dstAssetDir, mkdirOptions);

        const promises = [];

        for (let page of this.#pagesInProgress)
            promises.push(this.#buildPage(page));
        
        await Promise.all(promises);
    }

    async #buildPage(page)
    {
        const mkdirOptions = { recursive: true };
        fs.mkdirSync(page.outputDir, mkdirOptions);

        //
        // Create an abort controller for graceful failure during the process
        //

        page.abortController = new AbortController();
        page.abortController.signal.addEventListener(
            'abort',
            (reason) =>
            {
                err(`Page ${page.uriPath} build aborted`);
                err(reason.target.reason.stack);

                this.#pagesWithErrors.add(page);
                this.#onPageBuildComplete(page);
            });
        
        //
        // page.thisBuild is a dedicated place for per-build data
        //

        page.thisBuild = {};
        
        //
        // Default page config - should this be in a dedicated file?
        //

        page.thisBuild.config =
            {
                client:
                    {
                        css:    { inline: true },
                        js:     { inline: true }
                    }
            };
        
        //
        // Reset the page watching
        //

        this.#addWatchFile(page.clientJsFileIn, page);
        this.#addWatchFile(page.htmlJsFileIn,   page);
        this.#addWatchFile(page.configJsFile,   page);
        this.#addWatchFile(this.#commonCssFile, page);
        
        if (page.configJsFile)
        {
            //
            // Page config files can override the default page config
            //

            import(page.configJsFile)
                .then(
                    (module) =>
                    {
                        module.default(page.thisBuild.config);

                        try
                        {
                            this.#buildClientJsPage(page);
                        }
                        catch(error)
                        {
                            err(`Error building client js for page ${page.uriPath}`);
                            page.abortController.abort(error);
                        }
                    });
        }
        else
        {
            try
            {
                this.#buildClientJsPage(page);
            }
            catch(error)
            {
                err(`Error building client js for page ${page.uriPath}`);
                page.abortController.abort(error);
            }
        }
    }

    #getBuildDurationSeconds()
    {
        const durationMs = new Date().getTime() - this.#buildStartTime.getTime();
        return (durationMs / 1000).toFixed(3);
    }

    #getBabelInputPlugin()
    {
        return  babel(
                {
                    sourceMaps: this.#developmentMode,
                    babelHelpers: 'inline',
                    filter:
                        (id) =>
                        {
                            // log(`Babel filter: ${id}`);

                            if (!id.includes('/node_modules/'))
                                return true;

                            //
                            // Generatelly, we do not want to run babel over dependencies from node_modules, as these are assumed 
                            // to be built packages.
                            //
                            // Exception - any file with a .jsx extension, which is assumed to contain inline JSX that we want to
                            // convert and also extract scoped css="..." from.
                            //

                            if (id.endsWith('.jsx'))
                                return true;
                            
                            //
                            // Otherwise, don't run babel on this node_modules import.
                            //

                            return false;
                        },
                    skipPreflightCheck: this.#developmentMode,
                    plugins:
                        [
                            [
                                //
                                // Allow babel to understand JSX syntax, as well as transpile to our JSX.Create* javascript.
                                //
                                
                                resolveModule("@babel/plugin-transform-react-jsx"),
                                {
                                    pragma: "JSX.CreateElement",
                                    pragmaFrag: "JSX.CreateFragment"
                                }
                            ],
                            [
                                // Our babel plugin extracts scoped css="..." from JSX
                                nakedJsxSourceDir + "/babel/plugin-scoped-css.mjs"
                            ]
                        ]
                });
    }

    #getBabelOutputClientPlugin()
    {
        return  getBabelOutputPlugin(
                    {
                        sourceMaps: this.#developmentMode,
                        // exclude: 'node_modules/**',
                        plugins:
                            [
                                // Our babel plugin that wraps the output in a self calling function, preventing creation of globals.
                                nakedJsxSourceDir + "/babel/plugin-iife.mjs"
                            ],
                        targets: this.#browserslistTargetQuery,
                        presets:
                            [[
                                // Final babel run to compile down to our browser target
                                resolveModule("@babel/preset-env"),
                                {
                                    bugfixes: true,
                                    modules: false  // Don't transform import statements - however, rollup should have removed them all.
                                }
                            ]],
                    });
    }

    #hashFileContent(content)
    {
        return createHash('sha1').update(content).digest('base64url');
    }

    async #hashAndRenameFile(filepath)
    {
        const content       = await fsp.readFile(filepath);
        const hash          = this.#hashFileContent(content);
        const parsed        = path.parse(filepath);
        const hashFilename  = parsed.name + '.' + hash + parsed.ext;

        await fsp.rename(filepath, parsed.dir + '/' + hashFilename);

        return hashFilename;
    }

    async #importAssetDefault(asset, setCacheResult)
    {
        //
        // A straight copy of the asset with a hash embedded in the filename.
        //
        // import some_svg from 'image.svg'
        // ...
        // some_svg == '/asset/image.<hash>.svg'
        //

        const content   = await fsp.readFile(asset.file);
        const hash      = this.#hashFileContent(content);
        const parsedId  = path.parse(asset.id);
        const filename  = `${parsedId.name}.${hash}${parsedId.ext}`;
        const filepath  = `${this.#dstAssetDir}/${filename}`;
        const uriPath   = `/asset/${filename}`;
        const result    = `export default '${uriPath}'`;

        // Other async loads don't need to wait for the copy operation
        setCacheResult(result);

        await fsp.writeFile(filepath, content);
        log(`Copied asset ${uriPath}\n`+
            `        from ${asset.id}`);

        return result;
    }

    async #importAssetRaw(asset, setCacheResult)
    {
        //
        // Make the raw asset content available to source code, as a string.
        // Suitable for text content, such as an SVG, that you'd like to embed
        // the page html or client js.
        //

        const content = await fsp.readFile(asset.file);
        const result = `export default ${JSON.stringify(content.toString())};`;
        
        setCacheResult(result);
        return result;
    }

    async #importAsset(asset, setCacheResult)
    {
        // ?<asset type>:<asset options string>
        const match = asset.query?.match(/([^:]+):?(.*)/);

        if (!match)
            return await this.#importAssetDefault(asset, setCacheResult);
        
        const importType = match[1];
        asset.optionsString = match[2];

        if (importType === 'raw')
            return await this.#importAssetRaw(asset, setCacheResult);

        //
        // Check plugins first, this allows built-in plugins (raw) to be overridden
        //

        if (this.#assetImportPlugins.has(importType))
            return  await this.#assetImportPlugins.get(importType).importAsset(
                        {
                            // Useful data
                            dstAssetDir: this.#dstAssetDir,
                            
                            // Useful functions
                            hashAndRenameFile: this.#hashAndRenameFile.bind(this),
                            getCssClassName: getCssClassName,
                            setCacheResult
                        },
                        asset);

        throw new Error(`Unknown import plugin type '?${importType}' for import ${asset.id}.`);
    }

    #getImportPlugin()
    {
        const builder   = this;
        const cache     = this.#importLoadCache;
        
        return {
            name: 'nakedjsx-import-plugin',

            async resolveId(id, importer, options)
            {
                if (options.isEntry)
                    return null;

                // Check definitiions
                if (builder.#definitions[id])
                    return  {
                                id,
                                meta: { definedAs: builder.#definitions[id].value }
                            };
                
                // Check Javascript imports
                for (let alias in builder.#pathMapJs)
                    if (id.startsWith(alias))
                        return await fsp.realpath(id.replace(alias, builder.#pathMapJs[alias].path));

                // Check asset imports
                for (let alias in builder.#pathMapAsset)
                {
                    if (id.startsWith(alias + '/'))
                    {
                        const config = builder.#pathMapAsset[alias];

                        id = id.replace(alias, config.path);

                        const result =
                            {
                                id,
                                meta: { asset: { id } }
                            };
                        
                        const match = id.match(/([^?]*)\?(.*)/);

                        if (match)
                        {
                            result.meta.asset.file  = match[1];
                            result.meta.asset.query = match[2];
                        }
                        else
                        {
                            result.meta.asset.file = id
                        }
                        
                        return result;
                    }
                }

                return null;
            },

            async load(id)
            {
                const meta = this.getModuleInfo(id).meta;

                //
                // Have we predefined this?
                //

                if (meta.definedAs)
                    return `export default ${JSON.stringify(meta.definedAs)}`;

                //
                // From here it's either an asset or something for other plugins to load.
                //
                
                if (!meta.asset)
                    return null;
                
                //
                // It is one of our assets.
                //
                
                const mtime = (await fsp.stat(meta.asset.file)).mtimeMs;
                let cached  = cache.get(id);

                //
                // If it hasn't changed, we can use the cached result.
                //

                if (cached)
                {
                    if (mtime === cached.mtime)
                        return cached.result;
                
                    //
                    // Are we already loading it? If so, wait for that process.
                    //

                    if (cached.loadingPromise)
                    {
                        await cached.loadingPromise;
                        return cached.result
                    }
                }
                else
                {
                    cached = {};
                    cache.set(id, cached);
                }

                //
                // Store a promise in the cache that other async loads will
                // wait on. Extract the inner resolve callback so we can call
                // it once the cache has been updated. Perhaps there is a more
                // elegant way to achieve this?
                //

                cached.resolved = false;
                cached.loadingPromise =
                    new Promise(
                        (resolve) =>
                        {
                            cached.loadingPromiseResolve =
                                () => 
                                {
                                    cached.resolved = true;
                                    resolve();
                                }
                        });
                
                function setCacheResult(result)
                {
                    cached.mtime  = mtime;
                    cached.result = result;

                    //
                    // Cache result is now valid (enough, for other async loaders),
                    // remove and resolve our loading promise to unblock other loads.
                    //

                    const resolveLoadingPromise = cached.loadingPromiseResolve;
                    
                    delete cached.loadingPromise;
                    delete cached.loadingPromiseResolve;

                    resolveLoadingPromise();
                }

                const result = await builder.#importAsset(meta.asset, setCacheResult);

                //
                // If the plugin didn't set the cache result explicitly (as an optimisation),
                // then set it now to wake up other async imports of this asset.
                //

                if (!cached.resolved)
                    setCacheResult(result);
                
                return result;
            }
        };
    }

    #getTerserPlugin()
    {
        const developmentMode = this.#developmentMode;

        return  {
                    name: 'whenradar-terser',
                    async renderChunk(code, chunk, options, meta)
                    {
                        return  minify(
                                    code,
                                    {
                                        ecma:       2015,                       // Target browsers support es6
                                        module:     true,                       // "use strict" implied, unused top level functions and vars can be dropped
                                        compress:
                                            {
                                                ecma: 2015,
                                                passes: 2,                      // Shaves 40-50 bytes vs 1 pass on 2-4 KiB input

                                                // drop_console: !developmentMode, // this replaces console.log with void 0, which breaks use of code like const log = console.log.bind(console);

                                                //
                                                // Unsafe options that we have accepted ...
                                                //

                                                unsafe_arrows: true,            // Convert anon funcs to arrow funcs when 'this' not referenced. Breaks if function relies on 'prototype'
                                            },
                                        mangle:
                                            {
                                                // module: true,

                                                //
                                                // Unsafe options that we have accepted ...
                                                //

                                                // This breaks JSON objects prepared for external use, just as those sent to APIs
                                                // properties:                     // Mangling property names saves nearly 20% size on index and pricing calculator
                                                //     {
                                                //         // debug: "__MANGLE__"  // Enable to see what properties would be mangled in the output source
                                                //     }
                                            },
                                        sourceMap:  developmentMode
                                    })
                                    .then(
                                        result =>
                                        {
                                            return {
                                                code: result.code,
                                                map: result.decoded_map
                                            };
                                        });
                    }
                };
    }

    #getCommonInputPlugins()
    {
        const plugins =
            [
                // Babel for JSX and extracting scoped css
                mapCachePlugin(this.#getBabelInputPlugin(), this.#babelInputCache),

                // Our rollup plugin deals with our custom import behaviour (SRC, LIB, ASSET, ?raw, etc)
                mapCachePlugin(this.#getImportPlugin(), this.#babelInputCache),

                // Allow page code to make use of esm imports
                mapCachePlugin(nodeResolve(), this.#nodeResolveCache),

                // Allow page code to make use of commonjs imports
                mapCachePlugin(commonjs(), this.#commonjsCache),

                // Allow json files to be imported as data
                mapCachePlugin(json(), this.#jsonCache)
            ];
        
        return plugins;
    }

    #addWatchFile(filename, page)
    {
        if (!filename) // simplify calling code
            return;

        // Remove query string
        const queryIndex = filename.indexOf('?');
        if (queryIndex != -1)
            filename = filename.substring(0, queryIndex);

        // Associate filename with page
        let pagesThatUseFile = this.#watchFiles.get(filename);
        if (pagesThatUseFile)
            pagesThatUseFile.add(page);
        else
        {
            pagesThatUseFile = new Set();
            pagesThatUseFile.add(page);
            this.#watchFiles.set(filename, pagesThatUseFile);

            // First time - start watching the file
            if (fs.existsSync(filename)) // this can be false for internal things like 'rollupPluginBabelHelpers.js'
                this.#watcher.add(filename);
            // log(`  now watching ${filename}`);
        }
    }

    #emitFile(page, filename, content)
    {
        return fsp.writeFile(`${page.outputDir}/${filename}`, content);
    }

    #buildClientJsPage(page)
    {
        page.watchFiles = new Set();

        if (!page.clientJsFileIn)
        {
            this.#buildHtmlJs(page);
            return;
        }

        const inputOptions =
            {
                input: page.clientJsFileIn,
                plugins: this.#getCommonInputPlugins()
            };
        
        const outputOptions =
            {
                entryFileNames: '[name].[hash:64].js',
                format: 'es',
                sourcemap: this.#developmentMode,
                plugins:
                    [
                        mapCachePlugin(this.#getBabelOutputClientPlugin(), this.#babelOutputCache)
                    ]
            };
        
        //
        // Terser is used to compress the client js
        //

        if (!this.#developmentMode)
        {
            //
            // Terser pretty much kills step through debugging, so only enable it for production builds.
            //

            outputOptions.plugins.push(mapCachePlugin(this.#getTerserPlugin(), this.#terserCache));
        }            
        
        rollup(inputOptions)
            .then(
                (bundle) =>
                {
                    //
                    // Remember which files, if changed, should trigger a rebuild of this page.
                    // We'll add to this list after compiling the html js.
                    //

                    for (let watchFile of bundle.watchFiles)
                        this.#addWatchFile(watchFile, page);

                    return bundle
                        .generate(outputOptions)
                        .then(
                            (bundlerOutput) =>
                            {
                                bundle.close();

                                const moduleIds = [];
                                const promises = [];

                                const chunks = bundlerOutput.output.filter(output => output.type == 'chunk');
                                const assets = bundlerOutput.output.filter(output => output.type == 'asset');

                                //
                                // Always output assets (sourcemaps)
                                //

                                for (let output of assets)
                                {
                                    promises.push(this.#emitFile(page, output.fileName, output.source));
                                }

                                //
                                // Output client js if we're not inlining it
                                //

                                for (let output of chunks)
                                {
                                    moduleIds.push(output.moduleIds);

                                    if (page.thisBuild.config.client.js.inline)
                                    {
                                        if (page.thisBuild.inlineJs)
                                            page.thisBuild.inlineJs += output.code;
                                        else
                                            page.thisBuild.inlineJs = output.code;
                                    }
                                    else
                                    {
                                        promises.push(this.#emitFile(page, output.fileName, output.code));
                                        page.thisBuild.clientJsFileOut = output.fileName;
                                    }
                                }

                                Promise.all(promises)
                                    .then(
                                        () =>
                                        {
                                            page.thisBuild.clientJsModuleIds = moduleIds.flat();

                                            // If none of our async tasks failed, continue to the html generation
                                            if (!this.#pagesWithErrors.has(page))
                                                this.#buildHtmlJs(page);
                                        });
                            })
                })
            .catch(
                (error) =>
                {
                    err(`error during rollup of ${page.clientJsFileIn}`);
                    page.abortController.abort(error);
                });
    }

    #buildHtmlJs(page)
    {
        if (!page.htmlJsFileIn)
        {
            page.abortController.abort(`Page ${page.uriPath} does not have a html js file and cannot produce ${page.htmlFile}`);
            return;
        }

        //
        // Our HTML pages are generated by executing the htmlJsFileIn.
        // But first we have to handle our custom asset imports and
        // extract our scoped css using our babel plugin.
        //

        const inputOptions =
            {
                input: page.htmlJsFileIn,
                plugins: this.#getCommonInputPlugins(),
                external: [
                    /^node:.*/
                ]
            };
    
        const outputOptions =
            {
                file: page.htmlJsFileOut,
                sourcemap: 'inline',
                format: 'es'
            };

        rollup(inputOptions)
            .then(
                (bundle) =>
                {
                    //
                    // Also watch the html js imports for changes.
                    //
                    // This includes any asset files and other custom imports.
                    //

                    for (let watchFile of bundle.watchFiles)
                        this.#addWatchFile(watchFile, page);

                    return bundle
                        .write(outputOptions)
                        .then(
                            (output) =>
                            {
                                bundle.close();

                                //
                                // We have produced the Javascript that will generate the html.
                                //
                                // Now we need to gather the necessary css to pass to the 
                                // html generation process.
                                //

                                let css = this.#commonCss;

                                page.thisBuild.htmlJsModuleIds =
                                    output.output
                                        .filter(output => output.type == 'chunk')
                                        .flatMap(output => output.moduleIds);

                                if (page.thisBuild.clientJsModuleIds)
                                    css += collateCss(page.thisBuild.htmlJsModuleIds.concat(page.thisBuild.clientJsModuleIds));
                                else
                                    css += collateCss(page.thisBuild.htmlJsModuleIds);
                                
                                page.thisBuild.inlineCss =
                                    loadCss(
                                        css,
                                        {
                                            renameVariables: true,
                                            development: true
                                        });

                                //
                                // In dev mode, inject the script that long polls the server for changes.
                                //

                                if (this.#developmentMode)
                                {
                                    if (page.thisBuild.inlineJs)
                                        page.thisBuild.inlineJs += this.#developmentModeClientJs;
                                    else
                                        page.thisBuild.inlineJs = this.#developmentModeClientJs;
                                }

                                const htmlFilePath = `${page.outputDir}/${page.htmlFile}`;
                                const worker = new Worker(page.htmlJsFileOut, { workerData: { page } });
                                
                                worker.on(
                                    'error',
                                    error =>
                                    {
                                        err(`Server js execution error in page ${page.uriPath}`);
                                        page.abortController.abort(error);
                                    });
                                worker.on(
                                    'exit',
                                    code =>
                                    {
                                        if(code !== 0)
                                            page.abortController.abort(Error(`Worker exited with code ${code} for page ${page.uriPath}`));
                                    });
                                worker.on(
                                    'message',
                                    htmlContent => 
                                    {
                                        fsp.writeFile(htmlFilePath, htmlContent)
                                            .then(
                                                () =>
                                                {
                                                    fsp.unlink(page.htmlJsFileOut)
                                                        .then(this.#onPageBuildComplete(page));
                                                });
                                    });
                            })
                })
            .catch(
                error =>
                {
                    err(`error during rollup of ${page.htmlJsFileIn}`);
                    page.abortController.abort(error);
                });
    }

    #onPageBuildComplete(page)
    {
        if (!this.#pagesInProgress.has(page))
        {
            // If one or more parallel build tasks failed we can end up here
            if (this.#pagesWithErrors.has(page))
                return;

            abort(`onPageBuildComplete called twice for page ${page.uriPath}, when page does not have errors`);
        }

        if (!this.#pagesWithErrors.has(page))
            log(`Built ${page.uriPath}`);

        this.#pagesInProgress.delete(page);

        if (this.#developmentMode)
        {
            //
            // Any browsers idling on this page need should reload
            //

            const idleClients = this.#idleClients.get(page.uriPath);
            if (idleClients)
            {
                this.#idleClients.delete(page.uriPath);

                for (let response of idleClients)
                    this.#respondUtf8(response, 200, 'application/json', JSON.stringify({ action: 'reload' }));
            }
        }

        if (!this.#pagesInProgress.size)
        {
            this.#building = false;

            if (this.#pagesToBuild.size)
            {
                this.#buildAll();
                return;
            }

            if (this.#pagesWithErrors.size)
                err(`\nFinished build (with errors) after ${this.#getBuildDurationSeconds()} seconds.\nNOTE: Some async tasks may yet complete and produce log output.`);
            else
                log(`\nFinished build after ${this.#getBuildDurationSeconds()} seconds.`);

            if (!this.#developmentMode)
                process.exit();
        }
    }
}