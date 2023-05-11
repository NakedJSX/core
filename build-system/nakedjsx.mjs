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
import inject from '@rollup/plugin-inject';

import { ScopedCssSet, loadCss } from './css.mjs'
import { mapCachePlugin } from './rollup/plugin-map-cache.mjs';
import { log, warn, err, fatal, isExternalImport, absolutePath, enableBenchmark } from './util.mjs';
import { DevServer } from './dev-server.mjs';
import HtmlRenderPool from './thread/html-render-pool.mjs';

const nakedJsxSourceDir = path.dirname(fileURLToPath(import.meta.url));

//
// We are using createRequire(..).resolve to allow babel to find the plugin under yarn pnp.
//

const resolveModule = createRequire(import.meta.url).resolve;

export const configFilename = '.nakedjsx.json';
export const emptyConfig =
    {
        pathAliases:                {},
        definitions:                {},
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

    #pathAliases        = {};
    #definitions        = {};

    #htmlRenderPool;

    #started            = false;
    #initialising       = true;
    #building           = false;
    
    #pages              = {};
    #pagesToBuild       = new Set();
    #pagesInProgress;
    #pagesWithErrors;

    #watcher;
    #watchFiles         = new Map(); // filename -> Set<page>

    #rollupPlugins;

    #terserCache        = new Map();
    #babelInputCache    = new Map();

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

    #importLoadCache    = new Map();

    constructor(
        rootDir,
        {
            configOverride
        } = {})
    {
        const packageFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '../package.json');
        const packageInfo = JSON.parse(fs.readFileSync(packageFile));

        log.setPrompt('Initialising ...');
        log(`NakedJSX ${packageInfo.version} initialising (Node ${process.version})`);

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
                fatal(`Failed to parse ${configFilePath}: ${error}`);
            }
        }
        else
            log(`No config file ${configFilename}, using default config`);

        // Definitions might be sensitive, so mask them when dumping the effective config
        const redactedConfig = Object.assign({}, JSON.parse(JSON.stringify(this.#config)));

        for (const key in redactedConfig.definitions)
            redactedConfig.definitions[key] = '****';

        log(`Effective config:\n${JSON.stringify(redactedConfig, null, 4)}`);

        //
        // Initialise the HTML rendering worker 'pool'
        //
        // NOTE: using more threads (eg. os.cpus().length) is slower or the same,
        // so this is more about isolating the execution of HTML generation JS.
        //

        this.#htmlRenderPool = new HtmlRenderPool(1);
    }

    async processConfig()
    {
        const config = this.#config;

        //
        // Source and destination directories
        //

        if (!config.outputDir)
            fatal("Config is missing required 'outputDir' and --out wasn't passed on CLI.");

        this.#srcDir = process.cwd();
        this.#dstDir = absolutePath(config.outputDir);
    
        if (this.#dstDir.startsWith(this.#srcDir + path.sep))
            fatal(`Output dir (${this.#dstDir}) must not be within the pages root dir (${this.#srcDir}).`);

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
                fatal(`Common CSS file ${this.#commonCssFile} doesn't exist`);
        }

        //
        // Process path aliases
        //

        for (const [alias, path] of Object.entries(config.pathAliases))
        {
            const absPath = absolutePath(path);
            if (!fs.existsSync(absPath))
                fatal(`Source import path ${absPath} for alias ${alias} does not exist`);

            this.#pathAliases[alias] = absPath;
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
            const { default: pluginRegistration } = await import(pluginPackageNameOrPath);

            pluginRegistration(
                (plugin) =>
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
                },
                { log, warn, err, fatal }
                );
        }
    }

    #logFinalThoughts()
    {
        let feebackChannels =
            'Email:   david.q.hogan@gmail.com\n' +
            'Discord: https://discord.gg/BXQDtub2fS';
        
        // // Check time vs expected expiry of Show HN post
        // if (new Date().getTime() < new Date(Date.UTC(2023, 4, 29, 7, 0, 0)).getTime())
        //     feebackChannels += `\nShow HN: TODO - post on HN and put URL here`;

        log.setPrompt(
`Thank you for trying this NakedJSX prerelease!

NOTE: Things subject to change until version 1.0.0.

Roadmap to 1.0.0:

- Support for JSX ref, including ability for HTML JS to make refs available to client JS
- Ability to configure default options for plugins
- Tests
- Incorporate feedback ...

Any feedback would be appreciated:

${feebackChannels}
`
            );
    }

    exit()
    {
        if (this.#htmlRenderPool)
            this.#htmlRenderPool.close();

        // wtf, there doesn't seem to be a close feature in the node http server.

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
            this.exit();
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
        const pageEntryMatch    = /^(.*)-(html|client|config)\.(jsx|mjs|js)$/;
        const match             = filename.match(pageEntryMatch);

        if (match)
        {
            const uriPath   = match[1] === 'index' ? '/' : ('/' + match[1]).replace(/\/index$/, '');
            const type      = match[2];
            const ext       = match[3];

            if ((type === 'html' || type === 'client') && ext !== 'jsx')
                throw Error(`Page file ${filename} should have .jsx extension`);

            if (type === 'config' && ext !== 'mjs' && ext !== 'js')
                throw Error(`Page config ${filename} should have .mjs or .js extension`);

            const htmlFile  = path.basename(match[1] + '.html');
            const outputDir = path.resolve(`${this.#dstDir}/${path.dirname(match[1])}`);
            
            return {
                uriPath,
                type,
                htmlFile,
                outputDir
            };
        }
    }

    #addPageFileMatch(match, page, filename)
    {
        const fullPath = `${this.#srcDir}/${filename}`;

        if (match.type === 'html')
        {
            page.htmlJsFileIn       = fullPath;
            page.htmlJsFileOut    = `${this.#dstDir}/${filename}.mjs`;
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

        if (this.#pagesToBuild.size == 0)
        {
            log(`No pages to build.`);
            this.#onBuildComplete();
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

                if (reason.target.reason)
                    err(reason.target.reason.stack);

                this.#pagesWithErrors.add(page);
                this.#onPageBuildComplete(page);
            });
        
        //
        // page.thisBuild is a dedicated place for per-build data
        //

        page.thisBuild = { inlineJs: [] };

        page.thisBuild.scopedCssSet = new ScopedCssSet();
        page.thisBuild.scopedCssSet.reserveCommonCssClasses(this.#commonCss);
        
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
                            // Allow babel to transpile JSX syntax to our injected functions.
                            //
                            
                            resolveModule("@babel/plugin-transform-react-jsx"),
                            {
                                pragma:     '__nakedjsx_create_element',
                                pragmaFrag: '__nakedjsx_create_fragment'
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

        let result = '';

        function addJsx(meta, jsx)
        {
            result += `[${JSON.stringify(meta)},()=>${jsx}],\n`;
        }

        const fetchDynamicJsx = (await import(asset.file)).default;
        await fetchDynamicJsx({ addJsx });

        // Restore the previous cwd
        process.chdir(cwdBackup);

        return `export default [${result}]`;
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
                            // Useful data
                            dstAssetDir: this.#dstAssetDir,
                            
                            // Useful functions
                            hashAndRenameFile: this.#hashAndRenameFile.bind(this),
                            resolve: resolve
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
        for (const [ alias, path ] of Object.entries(this.#pathAliases))
            if (file.startsWith(alias + '/'))
            {
                file = file.replace(alias, path);
                break;
            }
        
        //
        // If the file path is not absolute by this stage,
        // interpret it relative to the importer (if we know it).
        //

        if (importer && !path.isAbsolute(file))
            file = absolutePath(file, path.dirname(importer));
        
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
                if (options.isEntry)
                    return null;
                
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
                                id: resolveModule(id),
                                external: 'absolute'
                            };
                }

                if (id === '@nakedjsx/core/jsx')
                {
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

                    return  {
                                id: resolveModule(id),
                                external: forClientJs ? false : 'absolute'
                            };
                }

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
                // Finally, can node resolve it from the deps that this build process knows about?
                //
                // This is what allows 'npx nakedjsx' to find the official plugins when
                // operating on standalone NakedJSX files (i.e. no package.json)
                //

                try {
                    const nodeResovledId = resolveModule(id);
                    let external = false;
                    if (!forClientJs && !nodeResovledId.endsWith('.jsx'))
                        external = 'absolute';

                    return  {
                                id: nodeResovledId,
                                external
                            };
                }
                catch(error)
                {
                    //
                    // We couldn't resolve it, let rollup handle it
                    //
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
                        return  minify(
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

                // Our import plugin deals with our custom import behaviour (SRC, LIB, ASSET, ?raw, etc) as well as JS module imports
                this.#getImportPlugin(forClientJs),

                // The babel JSX compiler will output code that refers to @nakedjsx/core/jsx exports
                inject(
                    {
                        '__nakedjsx_create_element':  ['@nakedjsx/core/jsx', '__nakedjsx_create_element'],
                        '__nakedjsx_create_fragment': ['@nakedjsx/core/jsx', '__nakedjsx_create_fragment']
                    }),
            ];
        
        return plugins;
    }

    #createRollupOutputPlugins(forClientJs)
    {
        const plugins = [];

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

        //
        // Most of our plugins are reused for all files, however our babel based css-extraction
        // needs to be able to receive a per-rollup-output-file object in which to place the
        // extracted CSS classes.
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
                                    scopedCssSet: page.thisBuild.scopedCssSet
                                }
                            ],

                            // Our babel plugin that wraps the output in a self calling function, preventing creation of globals.
                            path.join(nakedJsxSourceDir, 'babel', 'plugin-iife.mjs')
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
        
        const outputOptions =
            {
                entryFileNames: '[name].[hash:64].js',
                format: 'es',
                sourcemap: this.#developmentMode,
                plugins: [ babelOutputPlugin, ...this.#rollupPlugins.output.client ]
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
                                // emit or inline client JS if we're not inlining it
                                //

                                for (let output of chunks)
                                {
                                    moduleIds.push(output.moduleIds);

                                    if (page.thisBuild.config.client.js.inline)
                                    {
                                        page.thisBuild.inlineJs.push(output.code);
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
    
        const outputOptions =
            {
                file: page.htmlJsFileOut,
                sourcemap: 'inline',
                format: 'es',
                plugins: this.#rollupPlugins.output.server,
                globals: {
                    'Page': '@nakedjsx/core/page'
                }
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
                                    page.thisBuild.inlineJs.push(this.#developmentClientJs);

                                //
                                // Execution of the HTML generation JS happens in another thread.
                                //

                                const writePromises = [];
                                let failed = false;

                                this.#htmlRenderPool.render(
                                    {
                                        developmentMode:    this.#developmentMode,
                                        commonCss:          this.#commonCss,
                                        page
                                    },
                                    {
                                        onRendered({ htmlFilePath, htmlContent })
                                        {
                                            // If the Page.Render() didn't override the file name, use the default
                                            if (!htmlFilePath)
                                                htmlFilePath = page.htmlFile;
                                            
                                            const fullPath = path.normalize(path.join(page.outputDir, htmlFilePath));
                                            if (!fullPath.startsWith(page.outputDir))
                                            {
                                                err(`Page ${page.uriPath} attempted to render: ${fullPath}, which is outside of ${page.outputDir}`);
                                                failed = true;
                                            }
                                            else
                                            {
                                                log(`Page ${page.uriPath} rendered: ${htmlFilePath}`);
                                                writePromises.push(fsp.writeFile(fullPath, htmlContent));
                                            }
                                        },

                                        onComplete(error)
                                        {
                                            Promise
                                                .all(writePromises)
                                                .then(
                                                    () =>
                                                    {
                                                        if (failed || error)
                                                        {
                                                            err(`Server js execution error in page ${page.uriPath}`);
                                                            page.abortController.abort(error);
                                                            return;
                                                        }

                                                        if (builder.#developmentMode)
                                                        {
                                                            // Leave the generation JS file in dev mode
                                                            builder.#onPageBuildComplete(page);
                                                        }
                                                        else
                                                        {
                                                            fsp .unlink(page.htmlJsFileOut)
                                                                .then(() => builder.#onPageBuildComplete(page));
                                                        }
                                                    });
                                        }
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

        //
        // If nothing was placed in the destination asset dir, remove it
        //

        if (fs.readdirSync(this.#dstAssetDir).length == 0)
            fs.rmdirSync(this.#dstAssetDir);
        
        const hasErrors = !!this.#pagesWithErrors.size;

        if (!this.#developmentMode)
        {
            if (hasErrors)
                fatal(`Finished build (with errors).\nNOTE: Some async tasks may yet complete and produce log output.`);
            else
                log(`Finished build.`);
            
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