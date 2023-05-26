import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import inspector from 'node:inspector'

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

import chokidar from 'chokidar';
import { minify } from 'terser';
import { rollup } from 'rollup';
import { babel, getBabelOutputPlugin } from '@rollup/plugin-babel';
import inject from '@rollup/plugin-inject';
import jsBeautifier from 'js-beautify';

import { ScopedCssSet, loadCss } from './css.mjs'
import { mapCachePlugin } from './rollup/plugin-map-cache.mjs';
import { log, warn, err, fatal, absolutePath, enableBenchmark } from './util.mjs';
import { DevServer } from './dev-server.mjs';
import { assetUriPathPlaceholder } from '../runtime/page/document.mjs'
import { runWithPageAsyncLocalStorage } from '../runtime/page/page.mjs';

export const packageInfo = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../package.json')));

const nakedJsxSourceDir = path.dirname(fileURLToPath(import.meta.url));

//
// We are using createRequire(..).resolve to allow babel to find plugins under yarn pnp.
//

const resolveModule = createRequire(import.meta.url).resolve;

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
        plugins:                    [],
        importResolveOverrides:     {}
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

    #tmpRoot;
    #tmpDir;
    #tmpDirVersion          = -1;

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

    #watcher;
    #watchFiles             = new Map(); // filename -> Set<page>
    #watchFilesIgnore;

    #rollupPlugins;

    #terserCache            = new Map();
    #babelInputCache        = new Map();

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

    constructor(
        rootDir,
        {
            configOverride
        } = {})
    {
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

        this.#config = Object.assign({}, emptyConfig);

        if (configOverride)
        {
            Object.assign(this.#config, configOverride);
        }
        else if (fs.existsSync(configFilePath))
        {
            log(`Loading ${configFilePath}`);
            try
            {
                Object.assign(this.#config, JSON.parse(fs.readFileSync(configFilePath)));
            }
            catch(error)
            {
                fatal(`Failed to parse ${configFilePath}: ${error}`);
            }
        }
        else
            log(`No config file ${configFilePath}, using default config`);

        // Definitions might be sensitive, so mask them when dumping the effective config
        const redactedConfig = Object.assign({}, JSON.parse(JSON.stringify(this.#config)));

        for (const key in redactedConfig.definitions)
            redactedConfig.definitions[key] = '****';

        this.#config.quiet || log(`Effective config:\n${JSON.stringify(redactedConfig, null, 4)}`);
    }

    async processConfig()
    {
        const builder = this;
        const config = this.#config;

        //
        // Source and destination directories
        //

        if (!config.outputDir)
            fatal("Config is missing required 'outputDir' and --out wasn't passed on CLI.");

        this.#dstDir = path.join(this.#srcDir, config.outputDir);
    
        if (this.#dstDir.startsWith(this.#srcDir + path.sep))
            fatal(`Output dir (${this.#dstDir}) must not be within the pages root dir (${this.#srcDir}).`);

        if (!fs.existsSync(this.#dstDir))
        {
            log(`Creating output dir: ${this.#dstDir}`);
            fs.mkdirSync(this.#dstDir, { recursive: true });
        }
        
        this.#dstAssetDir   = path.join(this.#dstDir, 'asset');
        this.#tmpRoot       = path.join(this.#dstDir, '.__nakedjsx__tmp');

        //
        // Process path aliases
        //

        for (const [alias, destination] of Object.entries(config.pathAliases))
        {
            const absPath = path.join(this.#srcDir, destination);
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

        Object.assign(this.#definitions, config.definitions);

        //
        // Register plugins
        //

        for (let pluginPackageNameOrPath of config.plugins)
        {
            if (config.importResolveOverrides[pluginPackageNameOrPath])
                pluginPackageNameOrPath =
                    pathToFileURL(config.importResolveOverrides[pluginPackageNameOrPath]).href;

            const { default: pluginRegistration } = await import(pluginPackageNameOrPath);

            pluginRegistration(
                {
                    logging: { log, warn, err, fatal },

                    // Plugins call this to register themselves.
                    register: this.#registerPlugin.bind(this)
                });
        }
    }

    #registerPlugin(plugin)
    {
        const validIdRegex = /^[a-z0-9]([a-z0-9]*|[a-z0-9\-]*[a-z0-9])$/;

        if (!validIdRegex.test(plugin.id))
            fatal(`Cannot register plugin with bad id ${plugin.id}. An id can contain lowercase letters, numbers, and dashes. Can't start or end with dash.`);

        if (plugin.type === 'asset')
        {
            log(`Registering ${plugin.type} plugin with id: ${plugin.id}`);
            this.#assetImportPlugins.set(plugin.id, plugin);
        }
        else
            fatal(`Cannot register plugin of unknown type ${plugin.type}, (id is ${plugin.id})`);
    }

    #logFinalThoughts()
    {
        let feebackChannels =
            'Email:   contact@nakedjsx.org\n' +
            'Discord: https://discord.gg/BXQDtub2fS';
        
        // // Check time vs expected expiry of Show HN post
        // if (new Date().getTime() < new Date(Date.UTC(2023, 4, 29, 7, 0, 0)).getTime())
        //     feebackChannels += `\nShow HN: TODO - post on HN and put URL here`;

        log.setPrompt(
`Thank you for trying NakedJSX prerelease version ${packageInfo.version}!

NOTE: Things subject to change until version 1.0.0,
      breaking changes linked to Y increments in 0.Y.Z.

      After 1.0.0, breaking changes will be linked to
      X increments in X.Y.Z and of course all effort
      will be made to avoid them.

Roadmap to 1.0.0:

- TypeScript
- Ability to configure default options for plugins
- Tests
- Incorporate feedback
- ? Async JSX tags
- ? Client JSX refs to DOM nodes
- ? Ability for HTML JS to make refs available to client JS
- ? Deno / dpx

All feedback is appreciated:

${feebackChannels}
`
            );
    }

    exit()
    {
        this.#config.quiet || this.#logFinalThoughts();

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

        await this.processConfig();

        this.#developmentServer     = new DevServer({ serverRoot: this.#dstDir });
        this.#developmentClientJs   = fs.readFileSync(path.join(nakedJsxSourceDir, 'dev-client-injection.js')).toString();

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

        this.#started           = true;
        this.#developmentMode   = false;

        await this.processConfig();

        this.#startWatchingFiles();
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
        
        this.#enqueuePageBuild(...affectedPages);
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
    
        log(`Page ${match.page.htmlFile} removed ${match.type} file: ${filename}`);

        const page = this.#pages[match.page.uriPath];
        if (!page)
            throw new Error(`Page ${match.page.uriPath} not tracked for deleted file ${filename}?`);

        const fullPath = `${this.#srcDir}/${filename}`;

        if (match.type === 'page' || match.type === 'html')
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
            throw new Error(`Bad page js file type ${match.page.type} for page ${match.uriPath}`);
        
        this.#enqueuePageBuild(page);
    }

    #matchPageJsFile(filename)
    {
        const pageEntryMatch    = /^(.*)-(page|html|client|config)\.(jsx|mjs|js)$/;
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
            page.htmlJsFileIn       = fullPath;
            page.htmlJsFileOutBase  = `${this.#dstDir}/${filename}`;
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
            fatal('#buildAll called while initialising');

        if (this.#building)
            fatal('#buildAll called while building');
        
        this.#building          = true;
        this.#pagesWithErrors   = new Set();
        this.#watchFilesIgnore  = new Set();

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

                this.#onPageBuildComplete(page, true);
            });
        
        //
        // page.thisBuild is a dedicated place for per-build data
        //

        page.thisBuild =
            {
                nextUniqueId:   0,
                inlineJs:       [],
                inlineJsSet:    new Set(),
                scopedCssSet:   new ScopedCssSet(),
                config:
                    {
                        client:
                            {
                                js: { inline: true }
                            }
                    },
                output:
                    {
                        inlineJs: [],
                        fileJs:   []
                    }
            };
        
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
                err(error);
                page.abortController.abort(error);
            }
        }

        await this.#buildHtmlJs(page);
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
                        // Magical source code transformations for the Page.* API.
                        path.join(nakedJsxSourceDir, 'babel', 'plugin-magical-page-api.mjs'),

                        [
                            //
                            // Allow babel to transpile JSX syntax to our injected functions.
                            //
                            
                            resolveModule("@babel/plugin-transform-react-jsx"),
                            {
                                pragma:     '__nakedjsx__createElement',
                                pragmaFrag: '__nakedjsx__createFragment'
                            }
                        ]
                    ]
            };

        return babel(config);
    }

    #hashFileContent(content)
    {
        return createHash('sha1').update(content).digest('base64url');
    }

    async #hashAndRenameFile(filepath, dstDir)
    {
        const content       = await fsp.readFile(filepath);
        const hash          = this.#hashFileContent(content);
        const parsed        = path.parse(filepath);
        const hashFilename  = parsed.name + '.' + hash + parsed.ext;

        await fsp.rename(filepath, path.join(dstDir, hashFilename));

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
        const filepath  = `${this.#dstAssetDir}/${filename}`;
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
        // Make the raw asset content available to source code, as a string.
        // Suitable for text content, such as an SVG, that you'd like to embed
        // the page HTML or client JS.
        //

        const content = await fsp.readFile(asset.file);
        const result = `export default ${JSON.stringify(content.toString())};`;
        
        return result;
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
        // The asset js file is expected to export a function:
        //
        //     export default function({ addJsx }) { ... }
        //
        // where addJsx is a callback:
        //
        //     addJsx(meta, jsx)
        //
        // The JS exported function is expected to call addJsx(...)
        // for each dynamically fetched JSX snippet.
        //
        // meta is an arbitrary object to pass through to HTML rendering code
        // jsx is a string containing uncompiled JSX
        //
        // The result will be an array of [meta, FunctionGeneratedFromJsx]
        // such that HTML rendering code can use FunctionGeneratedFromJsx 
        // as a JSX tag.
        //
        // e.g.
        //
        // all.mjs:
        //
        //     import fsp from 'node:fs/promises'
        //    
        //     export default async ({ addJsx }) =>
        //     {
        //         for (const file of await fsp.readdir('.'))
        //         {
        //             if (!file.endsWith('.jsx'))
        //                 continue;
        //    
        //             addJsx({ file }, await fsp.readFile(file, { encoding: 'utf-8' }));
        //         }
        //     }
        //
        // index-html.mjs:
        //
        //     import posts from ':dynamic:posts/all.mjs'
        //
        //     global.SomeTag = ...
        //
        //     //
        //     // <SomeTag /> will be available for use inside <Post />,
        //     // the content of which came from an abitrary data source
        //     // with no need for import SomeTag from <somewhere> !
        //     //
        //    
        //     for (const [meta, Post] of posts)
        //     {
        //         Page.Create('en');
        //         Page.AppendBody(<Post />);
        //         Page.Render(meta.file.replace(/\.jsx$/, '.html'));
        //     }
        //

        // Change into the dir the file is in for convenience
        const cwdBackup = process.cwd();
        process.chdir(path.dirname(asset.file));

        try
        {
            let result = '';

            function addJsx(meta, jsx)
            {
                result += `[${JSON.stringify(meta)},()=>${jsx}],\n`;
            }

            const fetchDynamicJsx = (await import(pathToFileURL(asset.file).href)).default;
            await fetchDynamicJsx({ addJsx });

            return `export default [${result}]`;
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
                            hashAndOutputAsset: async (filename) => this.#hashAndRenameFile(filename, this.#dstAssetDir),
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

        throw new Error(`Unknown import type '${asset.type}' for import ${asset.id}.`);
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
                    // Since we know this is a yarn pnp thing, we can do a cheeky CLI one-liner 
                    // to get what we want.
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
        //

        if (!path.isAbsolute(file))
        {
            const nodeResolvedId = this.#nodeResolve(file, importer);

            if (nodeResolvedId)
                file = nodeResolvedId;
            else if (importer)
                file = absolutePath(file, path.dirname(importer));                
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

    #getImportPlugin(forClientJs)
    {
        const builder   = this;
        const cache     = this.#importLoadCache;
        
        return {
            name: 'nakedjsx-import-plugin',

            async resolveId(id, importer, options)
            {
                // if (options.isEntry)
                //     return null;
                
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

                if (id === '@nakedjsx/core/page')
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
                const resolveOverride = builder.#config.importResolveOverrides[id];
                if (resolveOverride)
                    return  {
                                id: resolveOverride,
                                external: false
                            };

                // for (const [pkg, override] of Object.entries(builder.#config.importResolveOverrides))
                // {
                //     if (id === pkg)
                //         return  {
                //                     id: override,
                //                     external: 'absolute'
                //                 };
                    
                //     if (id.startsWith(pkg + '/'))
                //         return  {
                //                     id: id.replace(pkg, override),
                //                     external: 'absolute'
                //                 };
                                
                // }

                // Asset imports
                if (id.startsWith(':'))
                {
                    const asset = builder.#parseAssetImportId(id, importer);
                    if (!asset)
                        return null;

                    return  {
                                id: asset.id,
                                meta: { asset }
                            };
                }

                // Definitiions
                if (builder.#definitions[id])
                    return  {
                                id,
                                meta: { definedAs: builder.#definitions[id] }
                            };

                // Check Javascript imports from aliased source paths
                for (const [ alias, path ] of Object.entries(builder.#pathAliases))
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
                const resolvedRelativePath = path.join(path.dirname(importer), id);
                if (fs.existsSync(resolvedRelativePath))
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

                const nodeResolvedId = builder.#nodeResolve(id, importer);
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
                                            toplevel: true,
                                        },
                                    sourceMap:  developmentMode
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

        const jsxImportPackage = forClientJs ? '@nakedjsx/core/client' : '@nakedjsx/core/page';

        injections =
            {
                '__nakedjsx__createElement':  [jsxImportPackage, '__nakedjsx__createElement'],
                '__nakedjsx__createFragment': [jsxImportPackage, '__nakedjsx__createFragment']
            };

        const plugins =
            [
                // Babel for JSX
                mapCachePlugin(this.#getBabelInputPlugin(forClientJs), this.#babelInputCache),

                // Our import plugin deals with our custom import behaviour (SRC, LIB, ASSET, ?raw, etc) as well as JS module imports
                this.#getImportPlugin(forClientJs),

                // The babel JSX compiler will output calls to __nakedjsx_* functions
                inject(injections),
            ];
        
        return plugins;
    }

    #createRollupOutputPlugins(forClientJs)
    {
        const plugins = [];

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

        if (!forClientJs && inspector.url())
            plugins.push(
                getBabelOutputPlugin(
                    {
                        sourceMaps: this.#developmentMode,
                        plugins:
                            [
                                path.join(nakedJsxSourceDir, 'babel', 'plugin-debug-workaround.mjs')
                            ],
                    }));

        if (forClientJs)
        {
            //
            // Terser is used to compress the client JS.
            // It pretty much kills step through debugging, so only enable it for production builds.
            //

            if (!this.#developmentMode)
                plugins.push(mapCachePlugin(this.#getTerserPlugin(), this.#terserCache));
        }
        
        return plugins;
    }

    /**
     * Ignore changes to this file for the duration of the build.
     */
    #ignoreWatchFile(id)
    {
        this.#watchFilesIgnore.add(id);
    }

    #addWatchFile(id, page)
    {
        if (!id) // simplify calling code
            return;

        //
        // Should we ignore it?
        //

        if (this.#watchFilesIgnore.has(id))
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
        return fsp.writeFile(`${page.outputRoot}/${filename}`, content);
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
        const builder = this;

        async function deleteAll(dir)
        {
            for (const entry of await fsp.readdir(dir, { withFileTypes: true }))
            {
                const fullPath = fs.realpathSync(path.join(dir, entry.name));
                if (!fullPath.startsWith(builder.#dstDir + path.sep))
                    throw Error(`path to delete (${fullPath}) not under dst dir (${builder.#dstDir})`);

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
        const { thisBuild } = page;

        //
        // In dev mode, inject the script that long polls the server for changes.
        //

        if (this.#developmentMode)
            thisBuild.inlineJs.push(this.#developmentClientJs);

        const input = [];
        const inputSourcemapRemap = {};

        if (page.clientJsFileIn)
            input.push(page.clientJsFileIn);

        if (thisBuild.inlineJs.length)
        {
            //
            // Although we have a unique folder name, it seems we also need a unique
            // filename to work around vscode breakpoint binding bugs when repeatedly
            // dynamically import()ing.
            //

            const inlineJs          = thisBuild.inlineJs.join(';\n');
            const inlineJsFilename  = page.htmlFile.replace(/.[^.]+$/, '-inline.mjs');
            const tmpSrcFile        = this.#versionedTmpFilePath(inlineJsFilename);

            // Make inline source look like it came from src/<page>-inline.mjs'
            inputSourcemapRemap[tmpSrcFile] = path.join(this.#srcDir, inlineJsFilename);

            this.#ignoreWatchFile(tmpSrcFile);
            await fsp.writeFile(tmpSrcFile, inlineJs);

            input.push(tmpSrcFile);
        }

        if (!input.length)
            return;

        const inputOptions =
            {
                input,
                plugins: this.#rollupPlugins.input.client
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
                    sourceMaps: this.#developmentMode,
                    plugins:
                        [
                            // Our Scoped CSS extraction runs over the final tree shaken output
                            [
                                path.join(nakedJsxSourceDir, 'babel', 'plugin-scoped-css.mjs'),
                                {
                                    scopedCssSet: thisBuild.scopedCssSet
                                }
                            ],

                            // // Our babel plugin that wraps the output in a self calling function, preventing creation of globals.
                            // path.join(nakedJsxSourceDir, 'babel', 'plugin-iife.mjs')
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
                manualChunks: () => 'this name is not used but is needed',
                sourcemap: this.#developmentMode ? 'inline' : false,
                sourcemapPathTransform:
                    (relativeSourcePath, sourcemapPath) =>
                    {
                        const fullPath = path.resolve(path.dirname(sourcemapPath), relativeSourcePath);

                        
                        if (inputSourcemapRemap[fullPath])
                        {
                            // We remapped this path, convert to be relative to the sourcemap path dirname
                            return path.relative(path.dirname(sourcemapPath), inputSourcemapRemap[fullPath]);
                        }
                        else
                            return relativeSourcePath;
                    },
                plugins: [ babelOutputPlugin, ...this.#rollupPlugins.output.client ]
            };    
        
        let bundle;

        try
        {
            bundle = await rollup(inputOptions);
        }
        catch(error)
        {
            err(`Page client JavaScript compilation error in page ${page.uriPath}`);
            err(error);

            // Watch related files for changes
            for (let watchFile of error.watchFiles)
                this.#addWatchFile(watchFile, page);

            await this.#onPageBuildComplete(page, true);
            return;
        };
        
        //
        // Remember which files, if changed, should trigger a rebuild of this page.
        // We'll add to this list after compiling the html JS.
        //

        for (let watchFile of bundle.watchFiles)
            this.#addWatchFile(watchFile, page);

        const bundlerOutput = await bundle.generate(outputOptions);

        bundle.close();

        const promises = [];

        const chunks = bundlerOutput.output.filter(output => output.type === 'chunk' && output.imports.length == 0);
        const assets = bundlerOutput.output.filter(output => output.type === 'asset');

        //
        // Always output assets (sourcemaps)
        //

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

            if (thisBuild.config.client.js.inline)
                thisBuild.output.inlineJs.push(chunk.code);
            else
            {
                promises.push(this.#emitFile(page, chunk.fileName, chunk.code));
                thisBuild.output.fileJs.push(path.basename(chunk.fileName));
            }
        }

        return Promise.all(promises);
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

        const builder = this;

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

        thisBuild.htmlJsFileOut = this.#versionedTmpFilePath(page.htmlFile) + '.page.mjs';
    
        const outputOptions =
            {
                file:                       thisBuild.htmlJsFileOut,
                sourcemap:                  this.#developmentMode ? 'inline' : false,
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
            err(error);

            // Watch related files for changes
            for (let watchFile of error.watchFiles)
                this.#addWatchFile(watchFile, page);

            await builder.#onPageBuildComplete(page, true);
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
        
        //
        // Page JS is built, import it to execute
        //

        const writePromises = [];
        let failed = false;

        // take note of the keys in the default global scope
        const standardGlobalKeys = new Set(Object.keys(global));

        try
        {
            await currentJob
                .run(
                    {
                        developmentMode:    this.#developmentMode,
                        commonCss:          this.#commonCss,
                        page,
                        onRenderStart,
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
            err(error);
            failed = true;
        };

        // Remove anything added to global scope
        for (let key of Object.keys(global))
            if (!standardGlobalKeys.has(key))
                delete global[key];

        await Promise.all(writePromises);
                        
        if (failed)
        {
            err(`Server js execution error in page ${page.uriPath}`);
            await builder.#onPageBuildComplete(page, true);
            return;
        }

        // Leave the generation JS file in dev mode
        if (!builder.#developmentMode)
            await fsp.unlink(thisBuild.htmlJsFileOut);
            
        await builder.#onPageBuildComplete(page);

        async function onRenderStart(outputFilename)
        {
            log(`Page ${page.uriPath} rendering: ${outputFilename}`);

            thisBuild.nextOutputFilename = outputFilename;

            //
            // Now that Page.Render() has been called, we can finalise our common CSS
            // and reserve all known classes so that generated classes do not clash.
            //
            
            thisBuild.scopedCssSet.reserveCommonCssClasses(getCurrentJob().commonCss);

            //
            // Now that common CSS class names have been reserved, we can process
            // any client JS and extract / generate scoped CSS classes.
            //

            await builder.#buildClientJs(page);
        }

        function onRendered(htmlContent)
        {
            const outputFilename    = page.thisBuild.nextOutputFilename;
            const fullPath          = path.normalize(path.join(page.outputRoot, outputFilename));

            if (!fullPath.startsWith(builder.#dstDir ))
            {
                err(`Page ${page.uriPath} attempted to render: ${fullPath}, which is outside of ${builder.#dstDir}`);
                failed = true;
                return;
            }

            if (builder.#config.pretty)
                htmlContent =
                    jsBeautifier.html_beautify(
                        htmlContent,
                        {
                            "indent_size": "4",
                            "indent_char": " ",
                            "max_preserve_newlines": "-1",
                            "preserve_newlines": false,
                            "keep_array_indentation": false,
                            "break_chained_methods": false,
                            "indent_scripts": "normal",
                            "brace_style": "collapse",
                            "space_before_conditional": true,
                            "unescape_strings": false,
                            "jslint_happy": false,
                            "end_with_newline": false,
                            "wrap_line_length": "0",
                            "indent_inner_html": false,
                            "comma_first": false,
                            "e4x": false,
                            "indent_empty_lines": false
                        });
            
            writePromises.push(fsp.writeFile(fullPath, htmlContent));
        }
    }

    async #onPageBuildComplete(page, hasError)
    {
        if (hasError)
            this.#pagesWithErrors.add(page);

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
        // If nothing was placed in the destination asset dir, remove it
        //

        if (fs.existsSync(this.#dstAssetDir) && fs.readdirSync(this.#dstAssetDir).length == 0)
            fs.rmdirSync(this.#dstAssetDir);
        
        const hasErrors = !!this.#pagesWithErrors.size;

        if (!this.#developmentMode)
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

        const prefix = hasErrors ? '(Build errors) ' : '';
        log.setPrompt(`${prefix}Development server: ${this.#developmentServer.serverUrl}, Press (x) to exit`);
    }
}