import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import inspector from 'node:inspector'
import querystring from 'node:querystring';
import EventEmitter from 'node:events';

import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

import chokidar from 'chokidar';
import { minify } from 'terser';
import { rollup } from 'rollup';
import { babel as babelRollupPlugin, getBabelOutputPlugin } from '@rollup/plugin-babel';
import inject from '@rollup/plugin-inject';
import prettier from 'prettier';

import { babel } from './util.mjs';
import { ScopedCssSet, loadCss } from './css.mjs'
import { log, warn, err, fatal, jsonClone, absolutePath, enableBenchmark, semicolonify, merge } from './util.mjs';
import { DevServer } from './dev-server.mjs';
import { assetUriPathPlaceholder } from '../runtime/page/document.mjs'
import { runWithPageAsyncLocalStorage } from '../runtime/page/page.mjs';

export const packageInfo = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../package.json')));

const nakedJsxSourceDir = path.dirname(fileURLToPath(import.meta.url));

//
// We are using createRequire(..).resolve to allow babel to find plugins under yarn pnp.
// But it's slow (~5ms) and doesn't cache internally.
//

const requireModule = createRequire(import.meta.url);
const resolveModule =
    ((id) =>
    {
        const nodeResolveModule = requireModule.resolve;
        const cache = new Map();

        function resolve(id)
        {
            let resolved = cache.get(id);
            if (resolved)
                return resolved;
            
            resolved = nodeResolveModule(id);
            cache.set(id, resolved);

            return resolved;
        }

        return resolve;
    })();

//
// We'll create a directory called this, for creation and deletion of temporary files.
//

const nakedJsxTmpDirName = '.__nakedjsx__tmp';

//
// We make a 'current job' object available to page code being rendered.
// Due to the async nature of the build process we use AsyncLocalStorage.
//

const currentJob = new AsyncLocalStorage();

export function getCurrentJob()
{
    return currentJob.getStore();
}

export const configFilename = '.nakedjsx.json';
export const emptyConfig =
    {
        pathAliases:                {},
        definitions:                {},
        browserslistTargetQuery:    'defaults',
        plugins:                    {},
        importResolveOverrides:     {},
        output:
            {
                pageJs:             { sourcemaps: 'auto' },
                clientJs:           { sourcemaps: 'auto' }
            }
    };

export class NakedJSX extends EventEmitter
{
    #config;

    #developmentMode;
    #developmentServer;

    #templateEngineMode;
    #templateEnginePathHandlers;

    #srcDir;
    #dstDir;
    #dstAssetDir;

    #tmpRoot;
    #tmpDir;
    #tmpDirVersion          = -1;

    #pageJsSourceMaps       = false;
    #clientJsSourceMaps     = false;

    #commonCssFile;
    #commonCss;

    #assetImportPlugins     = new Map();

    #pathAliases            = {};
    #definitions            = {};

    #started                = false;
    #initialising           = true;
    #building               = false;
    
    #pages                  = {};
    #pagesToBuild           = new Set();
    #pagesInProgress;
    #pagesWithErrors;

    #clientJsOrigin;

    #watcher;
    #watchFiles             = new Map(); // filename -> Set<page>

    #rollupPlugins;

    //
    // This cache is used internally by our import plugin.
    //
    // We don't have generalised caching of rollup 'load' on the map cache plugin
    // as there's no clear path to implementing one when we can't know what
    // cache invalidation strategy to use for the wrapped load.
    //
    // In the case of our own custom imports, we know how to invalidate
    // so it is implemented internally.
    //

    #importLoadCache        = new Map();

    constructor(rootDir, { configOverride } = {})
    {
        super();

        log.quiet = !!configOverride?.quiet;

        log.setPrompt('Initialising ...');
        log(`NakedJSX ${packageInfo.version} initialising (Node ${process.version})`);

        //
        // All config paths are relative to the pages root dir
        //

        if (!fs.existsSync(rootDir))
            throw new Error(`Root dir ${rootDir} does not exist`);

        rootDir = fs.realpathSync(rootDir);
        
        log(`Root directory: ${rootDir}`);

        this.#srcDir = rootDir;
        
        //
        // Obtain config
        //

        const configFilePath = path.join(this.#srcDir, configFilename)

        this.#config = jsonClone(emptyConfig);

        if (configOverride)
        {
            merge(this.#config, configOverride);
        }
        else if (fs.existsSync(configFilePath))
        {
            log(`Loading ${configFilePath}`);
            try
            {
                merge(this.#config, JSON.parse(fs.readFileSync(configFilePath)));
            }
            catch(error)
            {
                fatal(`Failed to parse ${configFilePath}: ${error}`);
            }
        }
        else
            log(`No config file ${configFilePath}, using default config`);

        // Potentially update the log quiet setting.
        // TODO: avoid general double processing of the config when used via CLI
        log.quiet = !!this.#config.quiet;
    }

    absolutePathFromConfig(relativeOrAbsolute)
    {
        //
        // Config paths are either absolute or relative to srcDir
        //

        if (path.isAbsolute(relativeOrAbsolute))
            return relativeOrAbsolute;
        else
            return path.join(this.#srcDir, relativeOrAbsolute);
    }

    async processConfig()
    {
        const self   = this;
        const config = this.#config;

        //
        // Source and destination directories
        //

        if (config.outputDir) // deprecated config
        {
            if (config.output.dir)
                fatal("Config contains both 'output.dir' and deprecated 'outputDir' - please remove outputDir");
            
            config.output.dir = config.outputDir;
            delete config.outputDir;
        }

        if (!config.output?.dir)
            fatal("Config is missing required 'output.dir' and --out wasn't passed on CLI.");
        
        this.#dstDir = this.absolutePathFromConfig(config.output.dir);

        if (this.#dstDir.startsWith(this.#srcDir + path.sep))
            fatal(`Output dir (${this.#dstDir}) must not be within the pages root dir (${this.#srcDir}).`);

        if (!fs.existsSync(this.#dstDir))
        {
            log(`Creating output dir: ${this.#dstDir}`);
            fs.mkdirSync(this.#dstDir, { recursive: true });
        }

        //
        // Output dir for generated assets
        //

        if (!config.output.assetDir)
            config.output.assetDir = 'asset';
        
        if (path.isAbsolute(config.output.assetDir))
            this.#dstAssetDir = config.output.assetDir;
        else
            this.#dstAssetDir = path.join(this.#dstDir, config.output.assetDir);

        if (!this.#dstAssetDir.startsWith(this.#dstDir + path.sep) && this.#dstAssetDir !== this.#dstDir)
            fatal(`Output asset dir (${this.#dstAssetDir}) must be under or equal to dst dir (${this.#dstDir}).`);

        //
        // Sourcemaps default on when a a debugger is attached,
        // and for client JS, in development mode.
        //

        const validSourcemapsValues = ['auto', 'disable', 'enable'];

        if (!validSourcemapsValues.includes(config.output.pageJs.sourcemaps))
            fatal(`Bad config value '${config.output.pageJs.sourcemaps}' for output.pageJs.sourcemaps. Valid values are ${validSourcemapsValues.join()}`);

        if (!validSourcemapsValues.includes(config.output.clientJs.sourcemaps))
            fatal(`Bad config value '${config.output.clientJs.sourcemaps}' for output.clientJs.sourcemaps. Valid values are ${validSourcemapsValues.join()}`);

        function shouldEnableSourcemaps(setting)
        {
            if (setting === 'disable')
                return false;
            if (setting === 'enable')
                return true;
            if (setting === 'auto')
                return !!(inspector.url() || self.#developmentMode)

            fatal(`Unexpected config source map value: ${setting}`);
        }

        this.#pageJsSourceMaps      = shouldEnableSourcemaps(config.output.pageJs.sourcemaps);
        this.#clientJsSourceMaps    = shouldEnableSourcemaps(config.output.clientJs.sourcemaps);

        //
        // tmp defaults to inside the output dir
        // 

        if (!config.output.tmpDir)
            config.output.tmpDir = this.#dstDir;
        
        this.#tmpRoot = path.join(this.absolutePathFromConfig(config.output.tmpDir), nakedJsxTmpDirName);

        //
        // Process path aliases
        //

        for (const [alias, destination] of Object.entries(config.pathAliases))
        {
            const absPath = this.absolutePathFromConfig(destination);
            if (!fs.existsSync(absPath))
                fatal(`Source import path ${absPath} for alias ${alias} does not exist`);

            this.#pathAliases[alias] = absPath;
        }

        //
        // Common / external CSS
        //

        if (config.commonCssFile)
        {
            if (path.isAbsolute(config.commonCssFile))
            {
                if (!fs.existsSync(config.commonCssFile))
                    fatal(`Common CSS file ${config.commonCssFile} doesn't exist`);
                
                this.#commonCssFile = config.commonCssFile;
            }
            else
            {
                let testPath = this.#applyPathAliases(config.commonCssFile);
                if (testPath !== config.commonCssFile)
                {
                    if (!fs.existsSync(testPath))
                        fatal(`Common CSS file ${testPath} doesn't exist`);
                }
                else
                {
                    testPath = path.join(this.#srcDir, config.commonCssFile)
                    if (!fs.existsSync(testPath))
                        fatal(`Common CSS file ${config.commonCssFile} doesn't exist`);
                }

                this.#commonCssFile = testPath;
            }

            log(`Using common CSS file: ${this.#commonCssFile}`);
        }

        //
        // Copy definitiions
        //

        merge(this.#definitions, config.definitions);

        //
        // Register plugins
        //

        for (let [alias, pluginPackageNameOrPath] of Object.entries(config.plugins))
        {
            const validIdRegex = /^[a-z0-9]([a-z0-9]*|[a-z0-9\-]*[a-z0-9])$/;

            if (!validIdRegex.test(alias))
                fatal(`Cannot register plugin with bad alias ${alias}. An plugin alias can contain lowercase letters, numbers, and dashes. Can't start or end with dash.`);

            if (config.importResolveOverrides[pluginPackageNameOrPath])
            {
                pluginPackageNameOrPath =
                    pathToFileURL(config.importResolveOverrides[pluginPackageNameOrPath]).href;
            }
            else if (!fs.existsSync(pluginPackageNameOrPath))
            {
                //
                // Is it a project file?
                //

                const projectFileTestPath = absolutePath(pluginPackageNameOrPath, this.#srcDir);
                if (fs.existsSync(projectFileTestPath))
                {
                    // Yes
                    pluginPackageNameOrPath = projectFileTestPath;
                }
                else
                {
                    //
                    // NOTE: Can't just use import() for this due to
                    // yarn PNP being very unhappy about using imports
                    // that aren't declared in dependencies. It needs
                    // unambigious paths to be used in this case.
                    //

                    try
                    {
                        // Try local modules available to the source dir
                        const projectResolve    = createRequire(pathToFileURL(this.#srcDir)).resolve;
                        pluginPackageNameOrPath = projectResolve(pluginPackageNameOrPath);
                    }
                    catch (error)
                    {
                        // Try the global import paths
                        const { globalPaths } = requireModule('module');

                        for (const globalPath of globalPaths)
                        {
                            try
                            {
                                const globalResolve     = createRequire(pathToFileURL(globalPath)).resolve;
                                pluginPackageNameOrPath = globalResolve(pluginPackageNameOrPath);
                                break;
                            }
                            catch (error)
                            {
                                //
                                // Try the next path.
                                //
                                // If none work, we'll fall back to an import() of the
                                // package name, which is how any plugins bundled with
                                // nakedjsx itself load.
                                //
                            }
                        }
                    }
                }
            }

            const { default: pluginRegistration } = await import(pluginPackageNameOrPath);
            await pluginRegistration(
                {
                    logging: { log, warn, err, fatal },

                    // Plugins call this to register themselves.
                    register: this.#registerPlugin.bind(this, pluginPackageNameOrPath, alias)
                });
        }

        // Definitions might be sensitive, so mask them when dumping the effective config
        const redactedConfig = jsonClone(JSON.parse(JSON.stringify(this.#config)));

        for (const key in redactedConfig.definitions)
            redactedConfig.definitions[key] = '****';

        log(`Effective config (paths are relative to ${this.#srcDir}):\n${JSON.stringify(redactedConfig, null, 4)}`);
    }

    #registerPlugin(source, alias, plugin)
    {
        if (plugin.type === 'asset' || plugin.type === 'asset-import')
        {
            if (!(plugin.importAsset instanceof Function))
                fatal(`Asset plugin ${alias} does not provide 'importAsset()'`);

            this.#assetImportPlugins.set(alias, plugin);
        }
        else
            fatal(`Cannot register plugin ${alias} of unknown type ${plugin.type}`);

        log(`Registered ${plugin.type} plugin ${alias} from ${source}`);
    }

    #logFinalThoughts()
    {
        let feebackChannels =
            'Email:   contact@nakedjsx.org\n' +
            'Discord: https://discord.gg/BXQDtub2fS';

        log.setPrompt(
`Thank you for trying NakedJSX prerelease version ${packageInfo.version}!

NOTE: Things subject to change until version 1.0.0,
      breaking changes linked to Y increments in 0.Y.Z.

      After 1.0.0, breaking changes will be linked to
      X increments in X.Y.Z and of course all effort
      will be made to avoid them.

Roadmap:

- Incorporate feedback
- Don't allow unbounded cache growth
- Integrated http proxy
- ImageMagick support in @nakedjsx/plugin-asset-image
- Ability to configure default options for plugins
- Ability to associate plugins with file extensions
- Tests

Seeking feedback:

- Basic support for TypeScript has been added.
  VSCode 'problems' experience not ideal.

Under consideration:

- Client JSX ref support
- Client JSX context support
- Support Deno / dpx

All feedback is appreciated:

${feebackChannels}
`
            );
    }

    exit()
    {
        this.#logFinalThoughts();

        process.exit(0);
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
        this.#templateEngineMode    = false;

        await this.processConfig();

        this.#developmentServer =
            new DevServer(
                {
                    serverRoot:     this.#dstDir,
                    clientJsFile:   path.join(nakedJsxSourceDir, 'dev-client-injection.js')
                });

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
                    let char;
                    
                    while(char = process.stdin.read(1))
                    {
                        switch (char.toLowerCase())
                        {
                            case 'x':
                                this.exit();
                                break;
                        }
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

        this.#started               = true;
        this.#developmentMode       = false;
        this.#templateEngineMode    = false;

        await this.processConfig();

        this.#startWatchingFiles();
    }

    /**
     * Start a template engine
     */
    async templateEngine()
    {
        if (this.#started)
            throw Error('NakedJSX already started');
        
        this.#started                       = true;
        this.#developmentMode               = false;
        this.#templateEngineMode            = true;
        this.#templateEnginePathHandlers    = new Map();

        await this.processConfig();

        this.#startWatchingFiles();
    }

    /**
     * Render a template engine path.
     */
    async templateEngineRender(uriPath, context)
    {
        const handler = this.#templateEnginePathHandlers.get(uriPath);
        if (!handler)
            throw (`NakedJSX does not have a handler for uriPath: ${uriPath}`);

        const htmlResult =
            await new Promise(
                async (resolve, reject) =>
                {
                    await currentJob.run(
                        {
                            developmentMode:    this.#developmentMode,
                            templateEngineMode: this.#templateEngineMode,
                            commonCss:          this.#commonCss,
                            page:               handler.page,
                            onRenderStart:      this.#onRenderStart.bind(this),
                            onRendered:         html => resolve(html)
                        },
                        async () =>
                        {
                            await runWithPageAsyncLocalStorage(
                                async () =>
                                {
                                    try
                                    {
                                        await handler.render(context);        
                                    }
                                    catch (e)
                                    {
                                        err(e);
                                        reject(e);
                                    }
                                });
                        });
                });

        return htmlResult;
    }

    ////////////////
     
    #startWatchingFiles()
    {
        log(`Build server starting:\n` +
            `   input dir: ${this.#srcDir}\n` +
            `  output dir: ${this.#dstDir}`);

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
        // When we manually ask chokidar to track file imports outside of #srcDir,
        // we'll get a 'file added' event which will trigger this callback.
        //
        // We don't want to consider building pages starting from files outside
        // of #srcDir so we check for that here.
        //

        if (!path.join(this.#srcDir, filename).startsWith(this.#srcDir + path.sep))
            return;

        //
        // A file has been discovered under #srcDir.
        //
        // It might new a new page, or a new browser script for an existing page.
        //

        const match = this.#matchPageJsFile(filename);
        if (!match)
            return;
        
        log(`Page ${match.page.uriPath} added ${filename}`);

        let page = this.#pages[match.page.uriPath];
        if (!page)
        {
            page = match.page;
            this.#pages[match.page.uriPath] = page;
        }

        this.#addPageFileMatch(match, page, filename);
    }

    #numPageStr(num)
    {
        return (num == 1) ? '1 page' : `${num} pages`;
    }

    #considerChangedPageFile(filename)
    {
        log(`Changed file: ${filename}`);

        if (filename === configFilename)
        {
            log('Config updated, please restart.');
            this.exit();
        }

        //
        // A file has under #srcDir has changed.
        //

        const fullPath      = fs.realpathSync(`${this.#srcDir}/${filename}`);
        const affectedPages = this.#watchFiles.get(fullPath);
        if (!affectedPages)
            return;
        
        log(`Changed file ${fullPath} affects ${this.#numPageStr(affectedPages.size)}`);
        
        this.#enqueuePageBuild(Array.from(affectedPages));
    }

    #considerDeletedPageFile(filename)
    {
        //
        // A watched file has been deleted.
        //

        const match = this.#matchPageJsFile(filename);
        if (!match)
        {
            // it might be a dependency of a page rather than a top level page file
            return;
        }
    
        const page = this.#pages[match.page.uriPath];
        if (!page)
            throw new Error(`Page ${match.page.uriPath} not tracked for deleted file ${filename}?`);

        log(`Page ${page.uriPath} removed ${match.type} file: ${filename}`);

        const fullPath = `${this.#srcDir}/${filename}`;

        if (match.type === 'page' || match.type === 'html')
        {
            delete page.htmlJsFileIn;

            this.emit(
                NakedJSX.Events.page_delete,
                {
                    uriPath:    page.uriPath
                });
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
            throw new Error(`Bad page js file type ${match.page.type} for page ${match.uriPath}`);
        
        // If it still has a page JS file, rebuild it
        if (page.htmlJsFileIn)
            this.#enqueuePageBuild(page);
    }

    #matchPageJsFile(filename)
    {
        const pageEntryMatch    = /^(.*)-(page|html|client|config)\.(jsx|mjs|js|tsx|ts)$/;
        const match             = filename.match(pageEntryMatch);

        if (match)
        {
            const uriPath   = match[1] === 'index' ? '/' : ('/' + match[1]).replace(/\/index$/, '/');
            const type      = match[2];
            const ext       = match[3];

            if (type === 'config' && ext !== 'mjs')
                throw Error(`Page config ${filename} must have .mjs extension`);
            
            return  {
                        type,
                        page:
                            {
                                uriPath,
                                htmlFile:           `${match[1]}.html`,
                                outputDir:          path.resolve(`${this.#dstDir}/${path.dirname(match[1])}`),
                                outputRoot:         this.#dstDir,
                                outputAssetRoot:    this.#dstAssetDir
                            }
                    };
        }
    }

    #addPageFileMatch(match, page, filename)
    {
        const fullPath = `${this.#srcDir}/${filename}`;

        if (match.type === 'page' || match.type === 'html')
        {
            if (page.htmlJsFileIn && page.htmlJsFileIn !== fullPath)
            {
                warn(`Ignoring ${fullPath} due to clash with ${page.htmlJsFileIn} for page ${page.uriPath}`);
                return;
            }
            
            page.htmlJsFileIn = fullPath;

            this.emit(
                NakedJSX.Events.page_new,
                {
                    uriPath:    page.uriPath,
                    sourceFile: page.htmlJsFileIn
                });
        }
        else if (match.type === 'client')
        {
            page.clientJsFileIn = fullPath;
        }
        else if (match.type === 'config')
        {
            page.configJsFile = fullPath;
        }
        else
            throw new Error(`Bad page js file type ${match.type} for page ${match.uriPath}`);
        
        this.#enqueuePageBuild(page);
    }

    #enqueuePageBuild(pages)
    {
        if (!Array.isArray(pages))
            pages = [pages];

        for (let page of pages)
        {
            this.#pagesToBuild.add(page);

            // Disconnect this page from watch file rebuilds for now
            for (let [, pages] of this.#watchFiles)
                pages.delete(page);

            //
            // In template engine mode, if we don't yet have a handler for this uri path then install a
            // handler that parks requests until the build is complete. If we do have a handler,
            // then we choose to let it continue to serve requests until the new one is compiled.
            // 
            // May add an option to block, but the default is to prevent slow page builds from
            // blocking requests.
            //

            if (this.#templateEngineMode && !this.#templateEnginePathHandlers.has(page.uriPath))
            {
                const parkedRenders = [];
                const pathHandler =
                    {
                        page,
                        parkedRenders,
                        render:
                            (renderContext) =>
                            {
                                parkedRenders.push(new ParkedRender(renderContext));
                            }
                    };
                
                this.#templateEnginePathHandlers.set(page.uriPath, pathHandler);
            }
        }

        if (this.#initialising)
            return;

        if (!this.#building)
            this.#buildAll();
    }

    async #buildAll()
    {
        if (this.#initialising)
            fatal('#buildAll called while initialising');

        if (this.#building)
            fatal('#buildAll called while building');
        
        this.#building          = true;
        this.#pagesWithErrors   = new Set();

        // Remove old temp files, if any
        await this.#rmTempDir();
        await this.#mkTempDir();

        if (this.#pagesToBuild.size == 0)
        {
            log(`No pages to build.`);
            await this.#onBuildComplete();
            return;
        }

        enableBenchmark(true);

        log.setPrompt('Building ...');
        log(`\nBuilding ${this.#numPageStr(this.#pagesToBuild.size)} ...`);

        if (this.#commonCssFile)
        {
            try
            {
                this.#commonCss = loadCss((await fsp.readFile(this.#commonCssFile)).toString());
            }
            catch(error)
            {
                err(`Could not load common css: ${error}`);
                this.#commonCss = '';
            }
        }
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

        // Clear this out each build.
        this.#clientJsOrigin    = {};
        
        //
        // Start building.
        //

        const mkdirOptions = { recursive: true };
        await fsp.mkdir(this.#dstDir,      mkdirOptions);
        await fsp.mkdir(this.#dstAssetDir, mkdirOptions);

        const promises = [];

        for (let page of this.#pagesInProgress)
            promises.push(this.#buildPage(page));
        
        await Promise.all(promises);
    }

    async #buildPage(page)
    {
        const mkdirOptions = { recursive: true };
        await fsp.mkdir(page.outputDir, mkdirOptions);

        if (this.#commonCssFile)
            this.#addWatchFile(this.#commonCssFile, page);
        
        delete page.clientJsFileInContent;
        if (page.clientJsFileIn)
        {
            page.clientJsFileInContent = semicolonify((await fsp.readFile(page.clientJsFileIn)).toString());
            this.#addWatchFile(page.clientJsFileIn, page);
        }

        //
        // Create an abort controller for graceful failure during the process
        //

        page.abortController = new AbortController();
        page.abortController.signal.addEventListener(
            'abort',
            (reason) =>
            {
                err(`Page ${page.uriPath} build aborted`);

                if (reason.target.reason)
                    err(reason.target.reason.stack);

                this.#onPageBuildFailure(page);
            });
        
        //
        // page.thisBuild is a dedicated place for per-build page data.
        //

        page.thisBuild =
            {
                scopedCssSet: new ScopedCssSet(),
                cache:
                    {
                        clientJsRollup: new Map(),
                        memo:           {}  // will contain element and html caches for each memo
                    },
                config:
                    {
                        uniquePrefix: '_', // Used by Page.UniqueId()
                        uniqueSuffix: '',  // Used by Page.UniqueId()
                        client:
                            {
                                js: { inline: true }
                            }
                    }
            };
        
        //
        // We want these values to reset between each page rendered by a file.
        // Some page files output multiple pages, or render more than once
        // when NakedJSX used as a template engine.
        //

        page.thisBuild.onPageCreate =
            () =>
            {
                page.thisRender =
                    {
                        nextUniqueId:   0,
                        inlineJs:       [],
                        inlineJsSet:    new Set(),
                        noTreeShakeIds: new Set(),
                        output:
                            {
                                inlineJs: [],
                                fileJs:   []
                            }
                    };
            }
        
        if (page.configJsFile)
        {
            //
            // Page config files can override the default page config
            //

            this.#addWatchFile(page.configJsFile, page);

            try
            {
                const module = await import(pathToFileURL(page.configJsFile).href);   
                await module.default(page.thisBuild.config);
            }
            catch(error)
            {
                err(`Error executing page config file: ${page.configJsFile}`);
                err(error.stack);
                page.abortController.abort(error);
            }
        }

        await this.#buildHtmlJs(page);
    }

    #getBabelClientJsxPlugin()
    {
        return  [
                    //
                    // Our implementation of the automatic runtime results in larger client JS
                    // so we keep using the classic implemenation.
                    //

                    resolveModule("@babel/plugin-transform-react-jsx"),
                    {
                        runtime:    'classic',
                        pragma:     '__nakedjsx__createElement',
                        pragmaFrag: '__nakedjsx__createFragment'
                    }
                ];
    }

    #getBabelPageJsxPlugin()
    {
        return  [
                    //
                    // Our implementation of the automatic runtime results in larger client JS
                    // so we keep using the classic implemenation.
                    //

                    resolveModule("@babel/plugin-transform-react-jsx"),
                    {
                        runtime:        'automatic',
                        importSource:   '@nakedjsx/core/page'
                    }
                ];
    }

    #getBabelInputPlugin(forClientJs)
    {
        const plugins = [];

        if (forClientJs)
        {
            plugins.push(this.#getBabelClientJsxPlugin());
        }
        else
        {
            // JSX syntax (untransformed) needed by plugin-magical-page-api.mjs
            plugins.push(resolveModule('@babel/plugin-syntax-jsx'));
            plugins.push(path.join(nakedJsxSourceDir, 'babel', 'plugin-magical-page-api.mjs'));
            plugins.push(this.#getBabelPageJsxPlugin());
        }

        const config =
            {
                extensions: ['.jsx', '.mjs', '.js', '.tsx', '.ts'],
                sourceMaps: forClientJs ? this.#clientJsSourceMaps : this.#pageJsSourceMaps,
                babelHelpers: 'inline',
                presets: [resolveModule("@babel/preset-typescript")],
                plugins
            };
        
        if (process.env.NODE_ENV === 'production')
            config.skipPreflightCheck = true;
        else
            config.skipPreflightCheck = !(this.#developmentMode || inspector.url());

        return babelRollupPlugin(config);
    }

    #hashFileContent(content)
    {
        return createHash('sha1').update(content).digest('base64url');
    }

    async #hashAndMoveFile(filepath, dstDir)
    {
        const content       = await fsp.readFile(filepath);
        const hash          = this.#hashFileContent(content);
        const parsed        = path.parse(filepath);
        const hashFilename  = parsed.name + '.' + hash + parsed.ext;

        await fsp.rename(filepath, path.join(dstDir, hashFilename));

        return hashFilename;
    }

    async #hashAndCopyFile(filepath, dstDir)
    {
        //
        // TODO: This implementation is not suitable for large files
        //

        const content       = await fsp.readFile(filepath);
        const hash          = this.#hashFileContent(content);
        const parsed        = path.parse(filepath);
        const hashFilename  = parsed.name + '.' + hash + parsed.ext;

        await fsp.writeFile(path.join(dstDir, hashFilename), content);

        return hashFilename;
    }

    async #importAssetDefault(asset, resolve)
    {
        //
        // A straight copy of the asset with a hash embedded in the filename.
        //
        // import some_svg from '::image.svg'
        // ...
        // some_svg == '/asset/image.<hash>.svg'
        //

        const content   = await fsp.readFile(asset.file);
        const hash      = this.#hashFileContent(content);
        const parsedId  = path.parse(asset.id);
        const filename  = `${parsedId.name}.${hash}${parsedId.ext}`;
        const filepath  = path.join(this.#dstAssetDir, filename);
        const uriPath   = `${assetUriPathPlaceholder}/${filename}`;
        const result    = `export default '${uriPath}'`;

        // Other async loads don't need to wait for the copy operation
        resolve(result);

        await fsp.writeFile(filepath, content);
        log(`Copied asset ${filename}\n`+
            `        from ${asset.id}`);

        return result;
    }

    async #importAssetRaw(asset, resolve)
    {
        //
        // Make the raw asset content available to source code, as a string or a Buffer.
        //
        // Suitable for text content, such as an SVG, that you'd like to embed in the page.
        //

        const options =
            {
                as: 'utf-8', // Also supported: Buffer.

                ...querystring.decode(asset.optionsString)
            };

        if (options.as === 'Buffer')
        {
            // return code that creates the buffer from the file on demand
            const result =
`import fsp from 'node:fs/promises';
export default Buffer.from(await fsp.readFile(${JSON.stringify(asset.file)}));`;
        
            return result;
        }

        if (options.as === 'utf-8')
        {
            // return code that loads the file into a string on demand
            const result =
`import fsp from 'node:fs/promises';
export default (await fsp.readFile(${JSON.stringify(asset.file)})).toString();`;
        
            return result;
        }
        
        throw Error(`Bad 'as' for raw import: ${options.id}`);
    }

    async #importAssetJson(asset, resolve)
    {
        //
        // Running the JSON via parse -> stringify is technically
        // unnecessary but it does validate that the content is JSON.
        //

        const obj = JSON.parse(await fsp.readFile(asset.file));
        const result = `export default ${JSON.stringify(obj)};`;
        
        return result;
    }

    async #importAssetDynamic(asset, resolve)
    {
        //
        // :dynamic: assets imports create source code at *compile time*
        // which is then imported like any other source code import.
        //
        // The asset js file is expected to export a default async function:
        //
        //     export default async function(context) { ... }
        //
        // which is passed a context object containing:
        //
        //     file          - absolute path to the file being executed
        //     optionsString - ?key=value&... when import used like
        //                     import something from ':dynamic:<file.mjs>?key=value&...'
        //

        // Temporarily change into the dir the file is in
        const cwdBackup = process.cwd();
        process.chdir(path.dirname(asset.file));

        try
        {
            const context =
                {
                    file:           asset.file,
                    optionsString:  asset.optionsString
                };

            //
            // Import the default export from the dynamic js builder and execute it
            // to obtain the dynamically created source code.
            //

            const buildDynamicJs = (await import(pathToFileURL(asset.file).href)).default;
            return await buildDynamicJs(context);
        }
        finally
        {
            // Restore the previous cwd
            process.chdir(cwdBackup);
        }
    }

    async #importAsset(asset, resolve)
    {
        if (asset.type === 'default')
            return this.#importAssetDefault(asset, resolve);
        
        //
        // Check plugins first, this allows built-in plugins (raw, json) to be overridden
        //

        if (this.#assetImportPlugins.has(asset.type))
            return this.#assetImportPlugins.get(asset.type).importAsset(
                        {
                            // Useful functions
                            hashAndMoveAsset:   async (filename) => this.#hashAndMoveFile(filename, this.#dstAssetDir),
                            hashAndCopyAsset:   async (filename) => this.#hashAndCopyFile(filename, this.#dstAssetDir),
                            assetUriPath:       async (filename) => `${assetUriPathPlaceholder}/${filename}`,
                            mkdtemp:            async ()         => fsp.mkdtemp(path.join(this.#tmpDir, 'import-')),
                            resolve
                        },
                        asset);

        if (asset.type === 'raw')
            return this.#importAssetRaw(asset, resolve);
        
        if (asset.type === 'json')
            return this.#importAssetJson(asset, resolve);
        
        if (asset.type === 'dynamic')
            return this.#importAssetDynamic(asset, resolve);

        throw new Error(`Unknown import type '${asset.type}' for import ${asset.id}. Did you forget to enable a plugin?`);
    }

    #applyPathAliases(file)
    {
        if (path.isAbsolute(file))
            return file;
        
        // Apply path alias if one is used
        for (const [ alias, replacement ] of Object.entries(this.#pathAliases))
            if (file.startsWith(alias + '/'))
                return file.replace(alias, replacement);
        
        return file;
    }

    #nodeResolve(id, importer)
    {
        if (importer)
        {
            try
            {
                return createRequire(pathToFileURL(importer)).resolve(id);
            }
            catch(error)
            {
                if (error.code === 'MODULE_NOT_FOUND' && error.pnpCode === 'UNDECLARED_DEPENDENCY')
                {
                    //
                    // We are using yarn pnp, which is great, however it really doesn't
                    // like it when you try and import something that isn't declared as a dependency.
                    //
                    // This happens when a plugin exports some jsx that we've compiled into our page.
                    // If that code tries to use a package from where it came from, then it looks
                    // like NakedJSX itself it trying to import it.
                    //

                    err(
                        "It looks like you're using yarn pnp, and you're going to need to\n" +
                        "enable yarn pnp 'loose mode' to get rid of the following error.\n" +
                        "Even then it will log warnings so you might want to run with\n" +
                        "PNP_DEBUG_LEVEL=0 in your environment.\n");

                    throw error;
                }
            }
        }

        try
        {
            return resolveModule(id);
        }
        catch(error)
        {
        }
    }

    #parseAssetImportId(id, importer)
    {
        //
        // The id will start with ':[type]:' where [type] is an optional asset
        // type, such as default, raw, json, or as registered by a plugin.
        //
        // Example asset import code:
        //
        // import logo from ':image:$ASSET/logo.png?srcDensity=2'
        //
        // - asset type is 'image' (provided by @nakedjsx/plugin-asset-image)
        // - $ASSET has been configured as a path alias to a directory
        // - logo.png is a file within that directory
        // - The ?srcDensity=2 options string is passed to the image plugin
        //

        let [, type, file, optionsString] = id.match(/^:([a-z0-9\-]*):([^\?]*)\?*(.*)$/);

        if (type === undefined)
            return null;
        
        if (type === '')
            type = 'default';
        
        // Apply path alias if one is used
        file = this.#applyPathAliases(file);
        
        //
        // If the file path is not absolute by this stage,
        // attempt relative and then node resolution.
        //

        if (!path.isAbsolute(file))
        {
            const resolvedRelativePath = this.#resolveRelativePath(importer, file);
            if (resolvedRelativePath)
            {
                file = resolvedRelativePath;
            }
            else
            {
                const nodeResolvedId = this.#nodeResolve(file, this.#clientJsOrigin[importer] ?? importer);
                if (nodeResolvedId)
                    file = nodeResolvedId;
                else
                {
                    err(`Could not resolve id ${id} from ${importer}`);
                    return null;
                }
            }
        }
        
        //
        // Return the id in a standard format ideal for deduplication purposes.
        //
        
        if (optionsString)
            id = `:${type}:${file}?${optionsString}`;
        else
            id = `:${type}:${file}`;
        
        return { id, type, file, optionsString };
    }

    #resolveRelativePath(importer, id)
    {
        // Relative path to a source file?
        const importRelativeOrigin = importer.replace(/^(pageJs|clientJs):dynamic:/, '')
        const resolvedRelativePath =
            path.join(
                path.dirname(this.#clientJsOrigin[importRelativeOrigin] ?? importRelativeOrigin),
                id);
        if (fs.existsSync(resolvedRelativePath))
            return resolvedRelativePath;
        
        return undefined;
    }

    #getImportPlugin(forClientJs)
    {
        const self   = this;
        const cache  = this.#importLoadCache;
        
        return {
            name: 'nakedjsx-import-plugin',

            async resolveId(id, importer, options)
            {
                if (options.isEntry)
                    return null;
                
                if (id.startsWith('node:'))
                    return  {
                                id,
                                external: 'absolute'
                            };
                
                //
                // For the NakedJSX runtime, resolveModule is used to ensure
                // that @nakedjsx imports point to this instance of NakedJSX.
                //
                // This is key for the standalone npx nakedjsx tool to be able
                // to use its bundled copy of @nakedjsx/core to operate on files
                // that live outside of a node project that directly imports @nakedjsx.
                //

                if (id.startsWith('@nakedjsx/core/page'))
                {
                    //
                    // Only ever used to generate html - not used by client JS.
                    //
                    // @nakedjsx/core/page needs to be external, as it indirectly
                    // imports some css related deps that use dynamic require,
                    // which rollup doesn't handle.
                    //

                    return  {
                                id: pathToFileURL(resolveModule(id)).href, // Absolute externals must be in url form
                                external: 'absolute'
                            };
                }

                if (id === '@nakedjsx/core/client')
                {
                    // UPDATE THIS COMMENT

                    //
                    // @nakedjsx/core/page needs to be for client JS, and
                    // external for HTML JS.
                    //
                    // This is because page.mjs is external, and needs
                    // to use the same NakedJSX document as page / plugin code.
                    //
                    // In clientJS, where imports aren't supported, it must
                    // be internal (@nakedjsx/core/page is not used for HTML JS)
                    //
                    // On Windows, absolute externals need to be file:// URLs.
                    //

                    return  {
                                id: resolveModule(id),
                                external: false
                            };
                }

                // overriden by config?
                const resolveOverride = self.#config.importResolveOverrides[id];
                if (resolveOverride)
                    return  {
                                id: resolveOverride,
                                external: false
                            };

                // Asset imports
                if (id.startsWith(':'))
                {
                    const asset = self.#parseAssetImportId(id, importer);
                    if (!asset)
                        return null;

                    // The invoker of this rollup needs to know to watch this asset for this page
                    this.addWatchFile(asset.file);

                    return  {
                                // assets may render differently for client / page js (JSX in particular)
                                id: `${forClientJs ? 'client' : 'page'}Js${asset.id}`,
                                meta: { asset }
                            };
                }

                // Definitiions
                if (self.#definitions[id])
                    return  {
                                id,
                                meta: { definedAs: self.#definitions[id] }
                            };

                // Check Javascript imports from aliased source paths
                for (const [ alias, path ] of Object.entries(self.#pathAliases))
                    if (id.startsWith(alias))
                        return  {
                                    id: id.replace(alias, path),
                                    external: false
                                };

                // Absolute path to source file?
                if (path.isAbsolute(id) && fs.existsSync(id))
                    return  {
                                id: id,
                                external: false
                            };

                // Relative path to a source file?
                const resolvedRelativePath = self.#resolveRelativePath(importer, id);
                if (resolvedRelativePath)
                    return  {
                                id: resolvedRelativePath,
                                external: false
                            };

                //
                // Can node resolve it from the importer or the deps that this build process knows about?
                //
                // This is what allows 'npx nakedjsx' to find the official plugins when
                // operating on standalone NakedJSX files (i.e. no package.json)
                //

                const nodeResolvedId = self.#nodeResolve(id, importer);
                if (nodeResolvedId)
                {
                    let external = false;
                    if (!forClientJs && !nodeResolvedId.endsWith('.jsx'))
                        external = 'absolute';

                    return  {
                                id: external ? pathToFileURL(nodeResolvedId).href : nodeResolvedId,
                                external
                            };
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

                const assetJsSource = await self.#importAsset(meta.asset, resolve);

                //
                // The plugin may have returned JSX, so we run the result through babel.
                //

                const transformPlugins =
                    [
                        forClientJs
                            ? self.#getBabelClientJsxPlugin()
                            : self.#getBabelPageJsxPlugin()
                    ];
                const result = await babel.transformAsync(assetJsSource, { plugins: transformPlugins });

                //
                // If the plugin didn't set the cache result explicitly (as an optimisation),
                // then set it now to wake up other async imports of this asset.
                //

                if (!cached.resolved)
                    resolve(result.code);
                
                return result.code;
            }
        };
    }

    #getTerserPlugin()
    {
        // basically no point, too hard to follow once Terser has done its thing, but if it's enabled ...
        const sourceMap = this.#clientJsSourceMaps;

        return  {
                    name: 'terser',
                    async renderChunk(code, chunk, options, meta)
                    {
                        const result =
                            await minify(
                                code,
                                {
                                    toplevel: true,
                                    compress:
                                        {
                                            passes: 2, // Shaves 40-50 bytes vs 1 pass on 2-4 KiB input
                                        },
                                    mangle:
                                        {
                                            toplevel: true
                                        },
                                    sourceMap
                                });

                        return  {
                                    code: result.code,
                                    map: result.decoded_map
                                };
                    }
                };
    }

    #createRollupInputPlugins(forClientJs)
    {
        let injections;

        //
        // The JSX 'runtime' has been split into seperate implementations
        // for page and client.
        //

        const plugins =
            [
                // Babel for JSX
                this.#getBabelInputPlugin(forClientJs),

                // Our import plugin deals with our custom import behaviour (SRC, LIB, ASSET, ?raw, etc) as well as JS module imports
                this.#getImportPlugin(forClientJs)
            ];

        if (forClientJs)
            plugins.push(
                inject(
                    {
                        '__nakedjsx__createElement':  ['@nakedjsx/core/client', '__nakedjsx__createElement'],
                        '__nakedjsx__createFragment': ['@nakedjsx/core/client', '__nakedjsx__createFragment']
                    })
                );
        
        return plugins;
    }

    #createRollupOutputPlugins(forClientJs)
    {
        const plugins = [];

        if (forClientJs)
        {
            //
            // Terser is used to compress the client JS.
            // It pretty much kills step through debugging,
            // so don't enable it if sourcemaps are enabled.
            //

            if (!this.#clientJsSourceMaps)
                plugins.push(this.#getTerserPlugin());
        }
        else
        {
            const babelOutputPlugins = [];

            //
            // In template engine mode, we wrap everything (except imports) in
            // an exported rendering function.
            //

            if (this.#templateEngineMode)
                babelOutputPlugins.push(path.join(nakedJsxSourceDir, 'babel', 'plugin-template-engine-renderer.mjs'));

            //
            // If it appears that we are running under a debugger,
            // add our debug workaround plugin that injects a small
            // delay to the start of the page JS. This yucky hack
            // allows early breakpoints in pages to work.
            //
            // I will be delighted when this can be replaced with
            // something deterministic.
            //
            // https://github.com/microsoft/vscode-js-debug/issues/1510
            //

            // **** THIS MUST REMAIN BE THE LAST BABEL OUTPUT PLUGIN SO THAT THE INJECTED DELAY CODE IS FIRST IN THE FILE ****
            if (inspector.url())
                babelOutputPlugins.push(path.join(nakedJsxSourceDir, 'babel', 'plugin-debug-workaround.mjs'));

            if (babelOutputPlugins)
                plugins.push(
                    getBabelOutputPlugin(
                        {
                            sourceMaps: this.#pageJsSourceMaps,
                            plugins:    babelOutputPlugins
                        }));
        }
        
        return plugins;
    }

    #addWatchFile(id, page)
    {
        if (!id) // simplify calling code
            return;
        
        let file;

        //
        // If it's an asset, we need to know the file that it relates to.
        //

        if (id.startsWith(':'))
        {
            const parsedId = this.#parseAssetImportId(id);
            if (!parsedId)
                throw Error(`Attempt #addWatchFile(${id}, ${path.uriPath}): asset ID failed to parse`);

            file = parsedId.file;
        }
        else
        {
            file = id;
        }

        // Could be 'rollupPluginBabelHelpers.js', which is virtual
        if (!fs.existsSync(file))
            return;

        // Associate file with page
        let pagesThatUseFile = this.#watchFiles.get(file);
        if (pagesThatUseFile)
        {
            pagesThatUseFile.add(page);
        }
        else
        {
            pagesThatUseFile = new Set();
            pagesThatUseFile.add(page);
            this.#watchFiles.set(file, pagesThatUseFile);

            // First time - start watching the file
            this.#watcher.add(file);
        }
    }

    #emitFile(page, filename, content)
    {
        return fsp.writeFile(path.join(page.outputRoot, filename), content);
    }

    async #mkTempDir()
    {
        // Create a new one (uniquely named, to defeat import caching)
        this.#tmpDirVersion++;
        this.#tmpDir = path.join(this.#tmpRoot, `${this.#tmpDirVersion}`);
        await fsp.mkdir(this.#tmpDir, { recursive: true });
    }

    async #rmTempDir()
    {
        const self = this;

        async function deleteAll(dir)
        {
            for (const entry of await fsp.readdir(dir, { withFileTypes: true }))
            {
                const fullPath = fs.realpathSync(path.join(dir, entry.name));

                // Defensively only delete things that exist somewhere under tmpRoot
                if (!fullPath.startsWith(self.#tmpRoot + path.sep))
                    throw Error(`path to delete (${fullPath}) not under tmp dir (${self.#tmpRoot})`);

                // Also defensively only delete things that under a dir called <nakedJsxTmpDirName>
                if (!fullPath.split(path.sep).includes(nakedJsxTmpDirName))
                    throw Error(`path to delete (${fullPath}) not under a dir called ${nakedJsxTmpDirName}`);

                if (entry.isFile())
                    await fsp.unlink(fullPath);
                else if (entry.isDirectory(fullPath))
                    await deleteAll(fullPath);
                else
                    throw Error('Unexpected file type: ' + fullPath);
            }

            await fsp.rmdir(dir);
        }

        if (fs.existsSync(this.#tmpRoot))
            await deleteAll(this.#tmpRoot)
    }

    #versionedTmpFilePath(relativePath)
    {
        return path.join(this.#tmpDir, path.dirname(relativePath), `${this.#tmpDirVersion}.${path.basename(relativePath)}`)
    }

    async #buildClientJs(page)
    {
        const { thisRender } = page;

        if (!page.clientJsFileInContent && !thisRender.inlineJs.length)
            return;
        
        // Ensure each inline js ends with ';' before joining
        const inlineJs =
            thisRender.inlineJs
                .map(js => semicolonify(js))
                .join('\n\n');

        let combinedJs;
        if (page.clientJsFileInContent)
            combinedJs = page.clientJsFileInContent + '\n' + inlineJs;
        else
            combinedJs = inlineJs;

        //
        // combinedJs now contains the full client JS.
        //

        try
        {
            const result = await this.#rollupClientJs(page, combinedJs);

            //
            // Remember which files, if changed, should trigger a rebuild of this page.
            // We'll add to this list after compiling the html JS.
            //

            for (const watchFile of result.watchFiles)
                this.#addWatchFile(watchFile, page);

            if (result.inlineJs)
                thisRender.output.inlineJs.push(result.inlineJs);
        }
        catch (error)
        {
            err(`Page client JavaScript compilation error in page ${page.uriPath}`);
            err(error.stack);

            // Watch related files for fixes
            if (error.watchFiles)
                for (let watchFile of error.watchFiles)
                    this.#addWatchFile(watchFile, page);

            return this.#onPageBuildFailure(page);
        }
    }

    async #rollupClientJs(page, combinedJs)
    {
        const { thisBuild, thisRender } = page;

        const inlineJsFilename = page.htmlFile.replace(/.[^.]+$/, '-page-client.mjs');
        
        //
        // Relative imports from client js files need to be relative from the original
        // file, not the rolled up tmpSrcFile. Our import plugin uses this object to
        // determine the original source file.
        //

        this.#clientJsOrigin[inlineJsFilename] = page.clientJsFileIn ?? page.htmlJsFileIn;

        // Check the cache first. Helps a LOT in template engine mode
        const cacheKey      = inlineJsFilename + '|' + combinedJs;
        const cachedResult  = thisBuild.cache.clientJsRollup.get(cacheKey);
        if (cachedResult)
            return cachedResult;
        
        //
        // Even though we rollup from memory, in dev mode place the combined client js
        // in the file system for manual debugging investigations
        //

        if (this.#developmentMode)
            await fsp.writeFile(this.#versionedTmpFilePath(inlineJsFilename), combinedJs);

        const inputOptions =
            {
                input:      inlineJsFilename,
                treeshake:  true,
                plugins:
                    [
                        {
                            name: 'nakedjsx-client-source',

                            resolveId(id)
                            {
                                if (id === inlineJsFilename)
                                    return inlineJsFilename;
                            },

                            load(id)
                            {
                                if (id === inlineJsFilename)
                                    return combinedJs;
                            }
                        },
                        ...this.#rollupPlugins.input.client
                    ]
            };

        //
        // Most of our plugins are reused for all files, however our babel based css-extraction
        // needs to be able to receive a per-rollup-output-file object in which to place the
        // extracted CSS classes.
        //
        // That object may have different reserved class names depending on the page being built.
        //

        const babelOutputPlugin =
            getBabelOutputPlugin(
                {
                    sourceMaps: this.#clientJsSourceMaps,
                    plugins:
                        [
                            // Our Scoped CSS extraction runs over the final tree shaken output
                            [
                                path.join(nakedJsxSourceDir, 'babel', 'plugin-scoped-css.mjs'),
                                {
                                    scopedCssSet: thisBuild.scopedCssSet
                                }
                            ]
                        ],
                    targets:    this.#config.browserslistTargetQuery,
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

        //
        // NOTE:
        //
        // Some effort went to finding a rollup config that would place both the
        // <page>-client.mjs code and the Page.AppendJs() code in a combined chunk.
        //
        
        const outputOptions =
            {
                entryFileNames: `${page.htmlFile}.[hash:64].js`,
                format: 'cjs',
                sourcemap: this.#clientJsSourceMaps ? 'inline' : false,
                plugins:
                    [
                        babelOutputPlugin,
                        ...this.#rollupPlugins.output.client
                    ]
            };

        //
        // All set; rollup
        //
        
        const bundle = await rollup(inputOptions);
        const output = (await bundle.generate(outputOptions)).output;
        const result =
            {
                watchFiles: [...bundle.watchFiles]
            };
        bundle.close();

        const chunks = output.filter(output => output.type === 'chunk' && output.imports.length == 0);
        const assets = output.filter(output => output.type === 'asset');

        //
        // Always output assets (which will be sourcemaps)
        //

        const promises = [];
        for (let output of assets)
            promises.push(this.#emitFile(page, output.fileName, output.source));

        //
        // Collate all Client JS
        //

        if (chunks.length > 1)
            throw Error('Rollup not behaving as expected, please report at: https://github.com/NakedJSX/core/issues');
        
        if (chunks.length)
        {
            const chunk = chunks[0];
            chunk.code  = chunk.code.trim();

            if (thisBuild.config.client.js.inline)
            {
                result.inlineJs = chunk.code;
            }
            else
            {
                promises.push(this.#emitFile(page, chunk.fileName, chunk.code));
                thisRender.output.fileJs.push(path.basename(chunk.fileName));
            }
        }

        // Wait for emitted files to be written
        await Promise.all(promises);

        // Cache and return
        thisBuild.cache.clientJsRollup.set(cacheKey, result);
        return result;
    }

    async #buildHtmlJs(page)
    {
        const { thisBuild } = page;

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
                plugins: this.#rollupPlugins.input.server
            };

        const pageMjsFilename = page.htmlFile.replace(/\.html$/, '-page.mjs');
        
        thisBuild.htmlJsFileOut = this.#versionedTmpFilePath(pageMjsFilename);

        const outputOptions =
            {
                file:                       thisBuild.htmlJsFileOut,
                sourcemap:                  this.#pageJsSourceMaps ? 'inline' : false,
                sourcemapExcludeSources:    true,
                format:                     'es',
                plugins:                    this.#rollupPlugins.output.server
            };

        let bundle;
        try
        {
            bundle = await rollup(inputOptions);
        }
        catch(error)
        {
            err(`Page compilation error in page ${page.uriPath}`);
            err(error.stack);

            // Watch related files for changes
            if (error.watchFiles)
                for (let watchFile of error.watchFiles)
                    this.#addWatchFile(watchFile, page);

            await this.#onPageBuildFailure(page);
            return;
        }

        //
        // Also watch the HTML JS imports for changes.
        //
        // This includes any asset files and other custom imports.
        //

        for (let watchFile of bundle.watchFiles)
            this.#addWatchFile(watchFile, page);

        const output = await bundle.write(outputOptions);

        bundle.close();

        if (this.#templateEngineMode)
            await this.#addTemplateEnginePath(page)
        else
            await this.#generatePageHtml(page)
    }

    async #addTemplateEnginePath(page)
    {
        const { thisBuild } = page;

        //
        // Page JS is built, make it available for template engine rendering
        //

        try
        {
            const module = await import(pathToFileURL(thisBuild.htmlJsFileOut).href)

            if (!module.render)
                throw new Error(`Imported page JS ${thisBuild.htmlJsFileOut} does not export render()`);

            const existingHandler = this.#templateEnginePathHandlers.get(page.uriPath);
            this.#templateEnginePathHandlers.set(
                page.uriPath,
                {
                    page:   page,
                    render: module.render
                });

            //
            // There may be parked requests in the previous handler
            //

            if (existingHandler.parkedRenders?.length)
                for (const parkedRender of existingHandler.parkedRenders)
                    parkedRender.renderNow(module.render);
        }
        catch(error)
        {
            err(`error during import of ${thisBuild.htmlJsFileOut}`);
            err(error.stack);

            return this.#onPageBuildFailure(page);
        }

        return this.#onPageBuildSuccess(page);
    }

    async #generatePageHtml(page)
    {
        const { thisBuild } = page;

        //
        // Page JS is built, import it to execute
        //

        const self          = this;
        const writePromises = [];
        let   failed        = false;

        try
        {
            await currentJob
                .run(
                    {
                        developmentMode:    this.#developmentMode,
                        templateEngineMode: this.#templateEngineMode,
                        commonCss:          this.#commonCss,
                        page,
                        onRenderStart:      this.#onRenderStart.bind(this),
                        onRendered
                    },
                    async () =>
                    {
                        await runWithPageAsyncLocalStorage(
                            async () => await import(pathToFileURL(thisBuild.htmlJsFileOut).href)
                            );
                    }
                );
        }
        catch(error)
        {
            err(`error during execution of ${thisBuild.htmlJsFileOut}`);
            err(error.stack);
            failed = true;
        };

        // onRendered() may have produced a bunch of HTML file write promises
        await Promise.all(writePromises);
                        
        if (failed)
        {
            err(`Server js execution error in page ${page.uriPath}`);
            await this.#onPageBuildFailure(page);
            return;
        }

        // Delete the generation JS file if not in dev mode
        if (!this.#developmentMode)
            await fsp.unlink(thisBuild.htmlJsFileOut);
            
        await this.#onPageBuildSuccess(page);

        function onRendered(htmlContent)
        {
            const outputFilename    = page.thisRender.outputFilename;
            const fullPath          = path.normalize(path.join(page.outputRoot, outputFilename));
            const fullOutputDir     = path.dirname(fullPath);

            if (!fullPath.startsWith(self.#dstDir ))
            {
                err(`Page ${page.uriPath} attempted to render: ${fullPath}, which is outside of ${self.#dstDir}`);
                failed = true;
                return;
            }

            if (!fs.existsSync(fullOutputDir))
            {
                //
                // This page has overriden the output path to include a new folder.
                //

                const mkdirOptions = { recursive: true };
                fs.mkdirSync(fullOutputDir, mkdirOptions);
            }

            if (self.#config.pretty)
                htmlContent =
                    prettier.format(
                        htmlContent,
                        {
                            parser:                     'html',
                            tabWidth:                   4,
                            singleQuote:                true,
                            semi:                       false,
                            arrowParens:                'avoid',
                            quoteProps:                 'preserve',
                            htmlWhitespaceSensitivity:  'strict'
                        });
            
            writePromises.push(fsp.writeFile(fullPath, htmlContent));
        }
    }

    async #onRenderStart(page, outputFilename)
    {
        log(`Page ${page.uriPath} rendering: ${outputFilename}`);

        page.thisRender.outputFilename = outputFilename;

        //
        // Now that Page.Render() has been called, we can finalise our common CSS
        // and reserve all known classes so that generated classes do not clash.
        //
        
        page.thisBuild.scopedCssSet.reserveCommonCssClasses(getCurrentJob().commonCss);

        //
        // Now that common CSS class names have been reserved, we can process
        // any client JS and extract / generate scoped CSS classes.
        //

        await this.#buildClientJs(page);
    }

    async #onPageBuildFailure(page)
    {
        this.#pagesWithErrors.add(page);

        await this.#onBuildComplete(page);
    }

    async #onPageBuildSuccess(page)
    {
        await this.#onPageBuildComplete(page);
    }

    async #onPageBuildComplete(page)
    {
        if (!this.#pagesInProgress.has(page))
        {
            // If one or more parallel build tasks failed we can end up here
            if (this.#pagesWithErrors.has(page))
                return;

            fatal(`onPageBuildComplete called twice for page ${page.uriPath}, when page does not have errors`);
        }

        if (!this.#pagesWithErrors.has(page))
            log(`Page ${page.uriPath} built`);

        this.#pagesInProgress.delete(page);

        if (this.#developmentServer)
        {
            //
            // Any browsers idling on this page need should reload
            //

            this.#developmentServer.onUriPathUpdated(page.uriPath);
        }

        if (!this.#pagesInProgress.size)
            await this.#onBuildComplete();
    }

    async #onBuildComplete()
    {
        this.#building = false;

        if (this.#pagesToBuild.size)
        {
            this.#buildAll();
            return;
        }

        //
        // If the asset dir is under dstDir, and if nothing
        // was placed in it, remove it.
        //

        if (fs.existsSync(this.#dstAssetDir))
            if (this.#dstAssetDir.startsWith(this.#dstDir + path.sep))
                if (fs.readdirSync(this.#dstAssetDir).length == 0)
                    fs.rmdirSync(this.#dstAssetDir);
        
        const hasErrors = !!this.#pagesWithErrors.size;

        if (!this.#developmentMode && !this.#templateEngineMode)
        {
            if (hasErrors)
                fatal(`Finished build (with errors).\nNOTE: Some async tasks may yet complete and produce log output.`);
            else
                log(`Finished build.`);

            await this.#rmTempDir();
            this.exit();
        }

        if (hasErrors)
            err(`Finished build (with errors).\nNOTE: Some async tasks may yet complete and produce log output.`);
        else
            log(`Finished build.`);
        
        enableBenchmark(false);

        if (this.#developmentMode)
        {
            const prefix = hasErrors ? '(Build errors) ' : '';
            const suffix = inspector.url() ? '' : ', Press (x) to exit';
            log.setPrompt(`${prefix}Development server: ${this.#developmentServer.serverUrl}${suffix}`);
        }
    }
}

class ParkedRender extends AsyncResource
{
    constructor(renderContext)
    {
        super('ParkedRender');
        this.renderContext = renderContext;
    }

    renderNow(renderFunction)
    {
        // Restore the original request async context and call the render function
        this.runInAsyncScope(renderFunction, null, this.renderContext);
    }
}

NakedJSX.Events =
    {
        /** A page has been discovered */
        page_new:       'page_new',

        /** A page is no longer available */
        page_delete:    'page_delete',
    };
