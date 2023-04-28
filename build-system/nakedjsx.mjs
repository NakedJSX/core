import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import chokidar from 'chokidar';
import { minify } from 'terser';
import { rollup } from 'rollup';
import { babel, getBabelOutputPlugin } from '@rollup/plugin-babel';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import { nodeResolve } from '@rollup/plugin-node-resolve';

import { loadCss } from './css.mjs'
import { mapCachePlugin } from './rollup/plugin-map-cache.mjs';
import { log, warn, err, abort, isExternalImport, absolutePath } from './util.mjs';
import { DevServer } from './dev-server.mjs';
import WorkerPool from './thread/pool.mjs';
import { scopedCssSetUsedByModules } from './babel/plugin-scoped-css.mjs';

const nakedJsxSourceDir = path.dirname(fileURLToPath(import.meta.url));

//
// We are using createRequire(..).resolve to allow babel to find the plugin under yarn pnp.
//

const resolveModule = createRequire(import.meta.url).resolve;

const configFilename = '.nakedjsx.json';
const emptyConfig =
    {
        importMapping:              {},
        browserslistTargetQuery:    'defaults',
        plugins:                    []
    };

export class NakedJSX
{
    #config;

    #developmentMode;
    #developmentServer;
    #developmentClientJs;

    #srcDir;
    #dstDir;
    #dstAssetDir;

    #commonCssFile;
    #commonCss;

    #assetImportPlugins = new Map();

    #pathMapJs          = {};
    #pathMapAsset       = {};
    #definitions        = {};

    #htmlRenderPool;

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

    #rollupPlugins;

    #terserCache        = new Map();
    #babelInputCache    = new Map();
    #babelOutputCache   = new Map();
    #importLoadCache    = new Map();
    #nodeResolveCache   = new Map();
    #commonjsCache      = new Map();
    #jsonCache          = new Map();

    constructor(
        rootDir,
        {
            configOverride
        } = {})
    {
        log(`NakedJSX initialising (Node ${process.version})`);

        rootDir = absolutePath(rootDir);

        //
        // All config paths are relative to the pages root dir
        //

        if (!fs.existsSync(rootDir))
            throw new Error(`Root dir ${rootDir} does not exist`);

        log(`Root and working directory: ${rootDir}`);
        process.chdir(rootDir);
        
        //
        // Obtain config
        //

        this.#config = Object.assign({}, emptyConfig);

        if (configOverride)
        {
            log(`Using overriden config - ignoring ${configFilename}`);
            Object.assign(this.#config, configOverride);
        }
        else if (fs.existsSync(configFilename))
        {
            log(`Loading ${configFilename}`);
            try
            {
                Object.assign(this.#config, JSON.parse(fs.readFileSync(configFilename)));
            }
            catch(error)
            {
                err(`Failed to parse ${configFilePath}: ${error}`);
                this.exit(1);
            }
        }
        else
            log(`No config file ${configFilename}, using default config`);

        // Definitions might be sensitive, so mask them when dumping the effective config
        const redactedConfig = Object.assign({}, this.#config);

        for (const [ alias, definition ] of Object.entries(redactedConfig.importMapping))
            if (definition.type === 'definition')
                redactedConfig.importMapping[alias].value = '****';

        log(`Config:\n${JSON.stringify(redactedConfig, null, 4)}`);

        //
        // Initialise the HTML rendering worker 'pool'
        //
        // NOTE: using more threads (eg. os.cpus().length) is slower or the same,
        // so this is more about isolating the execution of HTML generation JS.
        //

        this.#htmlRenderPool = new WorkerPool('HTML Render', 1);
    }

    async processConfig()
    {
        const config = this.#config;

        //
        // Source and destination directories
        //

        if (!config.outputDir)
        {
            err("Config is missing required 'outputDir'");
            this.exit(1);
        }

        this.#srcDir = process.cwd();
        this.#dstDir = absolutePath(config.outputDir);
    
        if (this.#dstDir.startsWith(this.#srcDir + path.sep))
        {
            err(`Output dir (${this.#dstDir}) must not be within the pages root dir (${this.#srcDir}).`);
            this.exit(1);
        }

        if (!fs.existsSync(this.#dstDir))
        {
            log(`Creating output dir: ${this.#dstDir}`);
            fs.mkdirSync(this.#dstDir); 
        }
        
        this.#dstAssetDir = path.join(this.#dstDir, 'asset');

        //
        // Common / external CSS
        //

        if (config.commonCssFile)
        {
            this.#commonCssFile = absolutePath(config.commonCssFile);
                
            if (!fs.existsSync(this.#commonCssFile))
            {
                err(`Common CSS file ${this.#commonCssFile} doesn't exist`);
                this.exit(1);
            }
        }

        //
        // Process import mappings
        //

        for (let [alias, value] of Object.entries(config.importMapping))
        {
            switch(value.type)
            {
                case 'source':
                    this.#pathMapJs[alias] = { ...value, path: absolutePath(value.path) };
                    if (!fs.existsSync(this.#pathMapJs[alias].path))
                    {
                        err(`Source import path ${this.#pathMapJs[alias].path} for alias ${alias} does not exist`);
                        this.exit(1);
                    }
                    break;

                case 'asset':
                    this.#pathMapAsset[alias] = { ...value, path: absolutePath(value.path) };
                    if (!fs.existsSync(this.#pathMapAsset[alias].path))
                    {
                        err(`Source import path ${this.#pathMapAsset[alias].path} for alias ${alias} does not exist`);
                        this.exit(1);
                    }
                    break;

                case 'definition':
                    this.#definitions[alias] = { ...value };
                    break;

                default:
                    throw Error(`Unsupported mapping type ${value.type}`);
            }
        }

        //
        // Register plugins
        //

        for (let pluginPackageNameOrPath of config.plugins)
        {
            const { default: pluginRegistration } = await import(pluginPackageNameOrPath);

            pluginRegistration(
                (plugin) =>
                {
                    if (plugin.type === 'asset')
                    {
                        log(`Registering ${plugin.type} plugin with id: ${plugin.id}`);
                        this.#assetImportPlugins.set(plugin.id, plugin);
                    }
                    else
                    {
                        err(`Cannot register plugin of unknown type ${plugin.type}, id ${plugin.id}`);
                        this.exit(1);
                    }
                });
        }
    }

    exit(code = 0)
    {
        log('Exiting ...');

        if (this.#htmlRenderPool)
            this.#htmlRenderPool.close();

        // wtf, there doesn't seem to be a close feature in the node http server.

        process.exit(code);
    }

    /**
     * Start a development build and web server.
     */
    async developmentMode()
    {
        if (this.#started)
            throw Error('NakedJSX already started');
        
        this.#started               = true;
        this.#developmentMode       = true;

        await this.processConfig();

        this.#developmentServer     = new DevServer({ serverRoot: this.#dstDir });
        this.#developmentClientJs   = fs.readFileSync(`${nakedJsxSourceDir}/dev-client-injection.js`).toString();

        this.#startWatchingFiles();

        //
        // Configure our shutdown handler if running in a terminal
        //

        if (process.stdin.isTTY)
        {
            process.on('SIGINT', this.exit);

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
                            this.exit();
                            break;
                    }
                });
        }
    }

    /**
     * Perform a production build.
     */
    async build()
    {
        if (this.#started)
            throw Error('NakedJSX already started');

        this.#started           = true;
        this.#developmentMode   = false;

        await this.processConfig();

        this.#startWatchingFiles();
    }

    ////////////////
     
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

        if (filename === configFilename)
        {
            log('Config updated, please restart.');
            this.exit(0);
        }

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
        const pageEntryMatch    = /^(.*)-(client|html|config)\.m?js$/;
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
        
        this.#buildStartTime    = new Date();
        this.#building          = true;
        this.#pagesWithErrors   = new Set();

        if (this.#pagesToBuild.size == 0)
        {
            log(`No pages to build.`);
            this.#onBuildComplete();
            return;
        }

        log(`Building ${this.#numPageStr(this.#pagesToBuild.size)} ...`);

        if (this.#commonCssFile)
            this.#commonCss = loadCss((await fsp.readFile(this.#commonCssFile)).toString());
        else
            this.#commonCss = '';
        
        this.#rollupPlugins =
            {
                input:
                    {
                        client: this.#createRollupInputPlugins(true),
                        server: this.#createRollupInputPlugins(false),
                    },
                output:
                    {
                        client: this.#createRollupOutputPlugins(true),
                        server: this.#createRollupOutputPlugins(false),
                    }
            };

        // This allows async events to safely queue up pages to build, during the build
        this.#pagesInProgress   = this.#pagesToBuild;
        this.#pagesToBuild      = new Set();
        
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

    #getBabelInputPlugin(forClientJs)
    {
        const config =
            {
                sourceMaps: this.#developmentMode,
                babelHelpers: 'inline',
                skipPreflightCheck: this.#developmentMode,
                plugins:
                    [
                        [
                            //
                            // Allow babel to transpile JSX syntax to our JSX.Create* javascript.
                            //
                            
                            resolveModule("@babel/plugin-transform-react-jsx"),
                            {
                                pragma: "JSX.CreateElement",
                                pragmaFrag: "JSX.CreateFragment"
                            }
                        ]
                    ]
            };

        if (forClientJs)
        {
            config.plugins.push(
                [
                    //
                    // This plugin extracts scoped css="..." from client JSX (only).
                    //
                    // We don't use it for server HTML JSX as this plugin runs at JSX transpile
                    // time, before the JSX prop values are known. If we used this plugin for
                    // HTML JSX transpiling, we wouldn't be able to have props alter the content
                    // of scoped CSS. This is HTML CSS is not final until HTML generation time.
                    //

                    nakedJsxSourceDir + "/babel/plugin-scoped-css.mjs",
                    {
                        commonCss: this.#commonCss
                    }
                ]);
        }

        return babel(config);
    }

    #getBabelOutputClientPlugin()
    {
        return  getBabelOutputPlugin(
                    {
                        sourceMaps: this.#developmentMode,
                        plugins:
                            [
                                // Our babel plugin that wraps the output in a self calling function, preventing creation of globals.
                                nakedJsxSourceDir + "/babel/plugin-iife.mjs"
                            ],
                        targets: this.#config.browserslistTargetQuery,
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

    async #importAssetDefault(asset, resolve)
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
        resolve(result);

        await fsp.writeFile(filepath, content);
        log(`Copied asset ${uriPath}\n`+
            `        from ${asset.id}`);

        return result;
    }

    async #importAssetRaw(asset, resolve)
    {
        //
        // Make the raw asset content available to source code, as a string.
        // Suitable for text content, such as an SVG, that you'd like to embed
        // the page HTML or client JS.
        //

        const content = await fsp.readFile(asset.file);
        const result = `export default ${JSON.stringify(content.toString())};`;
        
        return result;
    }

    async #importAsset(asset, resolve)
    {
        // ?<asset type>:<asset options string>
        const match = asset.query?.match(/([^:]+):?(.*)/);

        if (!match)
            return await this.#importAssetDefault(asset, resolve);
        
        const importType = match[1];
        asset.optionsString = match[2];

        if (importType === 'raw')
            return await this.#importAssetRaw(asset, resolve);

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
                            resolve: resolve
                        },
                        asset);

        throw new Error(`Unknown import plugin id '${importType}' for import ${asset.id}.`);
    }

    #getImportPlugin(forClientJs)
    {
        const builder   = this;
        const cache     = this.#importLoadCache;
        
        return {
            name: 'nakedjsx-import-plugin',

            async resolveId(id, importer, options)
            {
                //
                // Ensure that @nakedjsx imports point to this instance of NakedJSX.
                //
                // This is key for the standalone npx nakedjsx tool to be able
                // to use its bundled copy of @nakedjsx/core to operate on files
                // that live outside of a node project that directly imports @nakedjsx.
                //

                if (id.startsWith('@nakedjsx/'))
                {
                    const result = { id: resolveModule(id) };

                    //
                    // Client JS can't contain any import statements, so no imports can be external.
                    //
                    // For HTML JS, official @nakedjsx JSX components live within .jsx files.
                    // We can't treat these as external as they need to be transpiled,
                    // not imported directly at HTML generation time.
                    //

                    if (forClientJs || result.id.endsWith('.jsx'))
                        result.external = false;
                    else
                        result.external = true;
                    
                    return result;
                }

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

                // This import isn't one that we handle, defer to other plugins
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
                
                function resolve(result)
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

                const result = await builder.#importAsset(meta.asset, resolve);

                //
                // If the plugin didn't set the cache result explicitly (as an optimisation),
                // then set it now to wake up other async imports of this asset.
                //

                if (!cached.resolved)
                    resolve(result);
                
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

    #createRollupInputPlugins(forClientJs)
    {
        const plugins =
            [
                // Babel for JSX
                mapCachePlugin(this.#getBabelInputPlugin(forClientJs), this.#babelInputCache),

                // Our rollup plugin deals with our custom import behaviour (SRC, LIB, ASSET, ?raw, etc)
                mapCachePlugin(this.#getImportPlugin(forClientJs), this.#babelInputCache),

                // Allow page code to make use of esm imports
                mapCachePlugin(nodeResolve(), this.#nodeResolveCache),

                // Allow page code to make use of commonjs imports
                mapCachePlugin(commonjs(), this.#commonjsCache),

                // Allow json files to be imported as data
                mapCachePlugin(json(), this.#jsonCache)
            ];
        
        return plugins;
    }

    #createRollupOutputPlugins(forClientJs)
    {
        //
        // We currently don't use any rollup output plugins for the HTML JS.
        // It just needs to run once in the same node process, to produce HTML.
        //

        if (!forClientJs)
            return [];
        
        const plugins =
            [
                mapCachePlugin(this.#getBabelOutputClientPlugin(), this.#babelOutputCache)
            ];
        
        //
        // Terser is used to compress the client JS.
        // It pretty much kills step through debugging, so only enable it for production builds.
        //

        if (!this.#developmentMode)
            plugins.push(mapCachePlugin(this.#getTerserPlugin(), this.#terserCache));
        
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
                plugins: this.#rollupPlugins.input.client
            };
        
        const outputOptions =
            {
                entryFileNames: '[name].[hash:64].js',
                format: 'es',
                sourcemap: this.#developmentMode,
                plugins: this.#rollupPlugins.output.client
            };    
        
        rollup(inputOptions)
            .then(
                (bundle) =>
                {
                    //
                    // Remember which files, if changed, should trigger a rebuild of this page.
                    // We'll add to this list after compiling the html JS.
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
                                    promises.push(this.#emitFile(page, output.fileName, output.source));

                                //
                                // Output client JS if we're not inlining it
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

                                            // If none of our async tasks failed, continue to the HTML generation
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
            page.abortController.abort(`Page ${page.uriPath} does not have a HTML js file and cannot produce ${page.htmlFile}`);
            return;
        }

        log(`Building ${page.uriPath}`);

        //
        // Our HTML pages are generated by executing the htmlJsFileIn.
        // But first we have to handle our custom asset imports and
        // extract our scoped CSS using our babel plugin.
        //

        const inputOptions =
            {
                input: page.htmlJsFileIn,
                plugins: this.#rollupPlugins.input.server,
                external:
                    (id, parent, isResolved) =>
                    {
                        //
                        // Returning true from here prevents rollup from rolling up an
                        // import into the destination file.
                        //

                        //
                        // This first test is intended to allow compilation of 3rd party
                        // named exports containing actual JSX. For example via something like:
                        //
                        // import { ComponentOne, ComponentTwo } from 'third-party-library/jsx'
                        //
                        // Probably need to switch this to some sort of registration system.
                        //

                        if (id.includes('/jsx/') || id.endsWith('/jsx'))
                            return false;
                        
                        if (isExternalImport(id))
                        {
                            log(`Not rolling up ${id} from ${parent}`);

                            //
                            // We don't need to rollup node libraries for HTML JS that
                            // runs at compile time.
                            //

                            return true;
                        }

                        return false;
                    }
            };
    
        const outputOptions =
            {
                file: page.htmlJsFileOut,
                sourcemap: 'inline',
                format: 'es',
                plugins: this.#rollupPlugins.output.server
            };

        rollup(inputOptions)
            .then(
                (bundle) =>
                {
                    //
                    // Also watch the HTML JS imports for changes.
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
                                // In dev mode, inject the script that long polls the server for changes.
                                //

                                if (this.#developmentMode)
                                {
                                    if (page.thisBuild.inlineJs)
                                        page.thisBuild.inlineJs += this.#developmentClientJs;
                                    else
                                        page.thisBuild.inlineJs = this.#developmentClientJs;
                                }

                                const htmlFilePath = `${page.outputDir}/${page.htmlFile}`;

                                //
                                // Execution of the HTML generation JS happens in another thread.
                                //

                                this.#htmlRenderPool.runTask(
                                    {
                                        taskJsFile:         page.htmlJsFileOut,
                                        developmentMode:    this.#developmentMode,
                                        commonCss:          this.#commonCss,
                                        scopedCssSet:       scopedCssSetUsedByModules(page.thisBuild.clientJsModuleIds),
                                        page
                                    },
                                    // Task callback
                                    (error, generatedHtml) =>
                                    {
                                        if (error) {
                                            err(`Server js execution error in page ${page.uriPath}`);
                                            err(error);
                                            page.abortController.abort(error);
                                            return;
                                        }

                                        fsp.writeFile(htmlFilePath, generatedHtml)
                                            .then(
                                                () =>
                                                {
                                                    if (this.#developmentMode)
                                                    {
                                                        // Leave the generation JS in dev mode
                                                        this.#onPageBuildComplete(page);
                                                    }
                                                    else
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

        if (this.#developmentServer)
        {
            //
            // Any browsers idling on this page need should reload
            //

            this.#developmentServer.onUriPathUpdated(page.uriPath);
        }

        if (!this.#pagesInProgress.size)
            this.#onBuildComplete();
    }

    #onBuildComplete()
    {
        this.#building = false;

        if (this.#pagesToBuild.size)
        {
            this.#buildAll();
            return;
        }

        if (this.#pagesWithErrors.size)
            err(`Finished build (with errors) after ${this.#getBuildDurationSeconds()} seconds.\nNOTE: Some async tasks may yet complete and produce log output.`);
        else
            log(`Finished build after ${this.#getBuildDurationSeconds()} seconds.`);

        if (!this.#developmentMode)
            process.exit();
        
        log(`Development server: ${this.#developmentServer.serverUrl}, Press (x) to exit\nREADY`);
    }
}