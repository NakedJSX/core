
//
// This tool is just a simple config building and invocation wrapper.
//

import fs from 'node:fs';
import path from 'node:path';

import { packageInfo, configFilename, emptyConfig, NakedJSX } from './nakedjsx.mjs';
import { log, warn, fatal, jsonClone, camelToKebabCase, absolutePath, merge } from './util.mjs';

let developmentMode = false;    // --dev
let configSave      = false;    // --config-save
let configPathBase;
let rootDir;

function configPath(filepath)
{
    //
    // All paths passed on CLI are interpretted relative to configPathBase.
    // If the @nakedjsx/code invocation wasn't forwarded, then it likely
    // won't be set yet and we use an intuitive default of cwd.
    //
    // Because invocation forwarding changes cwd, it also passes the original
    // cwd to use as a config path base via --cli-path-base.
    //

    if (!configPathBase)
        configPathBase = process.cwd();

    //
    // Convert an absolute or relative to configPathBase path
    // to one relative to the root dir config file.
    //

    return path.relative(rootDir, absolutePath(filepath, configPathBase));
}

const options =
    {
        '--import-resolve-override':
            {
                advanced: true,
                desc: 'Resolve imports of <pkg> as <location>.',
                args: ['pkg', 'location'],
                impl(config, { pkg, location})
                {                    
                    config.importResolveOverrides[pkg] = location;
                }
            },

        '--do-not-forward':
            {
                advanced: true,
                desc: 'Use the running @nakedksx/core, do not consider forwarding to another installation.',
                impl()
                {                    
                    // no-op - this is handled by the cli-bin wrapper
                }
            },

        '--cli-path-base':
            {
                advanced: true,
                desc: 'Interpret CLI relative paths relative to <cli-path-base>',
                args: ['cliPathBase'],
                impl(config, { cliPathBase })
                {
                    if (configPathBase)
                        fatal('--cli-path-base must be before other path CLI options');
                    
                    configPathBase = absolutePath(cliPathBase);
                }
            },

        '--dev':
            {
                desc: 'Launch a hot-refresh development server',
                impl()
                {
                    developmentMode = true;
                }
            },
        
        '--config-save':
            {
                desc: 'Save the effective config to <pages-directory>/.nakedjsx.json',
                impl()
                {
                    configSave = true;
                }
            },
        
        '--out':
            {
                desc: 'The build output will be placed here',
                args: ['path'],
                deprecatedAlias: ['--output-dir'],
                impl(config, { path })
                {
                    if (config.output)
                        config.output.dir = configPath(path);
                    else
                        config.output = { dir: configPath(path) };

                    if (config.outputDir)
                        delete config.outputDir;
                }
            },

        '--css-common':
            {
                desc: 'CSS to compile and compress along with extracted scoped css="..." JSX attributes',
                args: ['pathToCssFile'],
                impl(config, { pathToCssFile })
                {
                    config.commonCssFile = configPath(pathToCssFile)
                }
            },

        '--plugin':
            {
                desc: 'Enable plugin and set its unique alias, for example: --plugin image @nakedjsx/plugin-asset-image',
                args: ['alias', 'pluginPackageNameOrPath'],
                async impl(config, { alias, pluginPackageNameOrPath })
                {
                    let finalPath;
                    const testPath = absolutePath(pluginPackageNameOrPath);

                    if (fs.existsSync(testPath))
                        finalPath = configPath(testPath);
                    else
                    {
                        // hopefully a package name like @nakedjsx/plugin-asset-image
                        finalPath = pluginPackageNameOrPath;
                    }
                    
                    if (config.plugins[alias] && config.plugins[alias] !== finalPath)
                        fatal(`Plugin alias '${alias}' already used by ${config.plugins[alias]}`);

                    config.plugins[alias] = finalPath;
                }
            },

        '--path-alias':
            {
                desc: 'Import path alias, eg. import something from \'$SRC/something.mjs\'',
                args: ['alias', 'path'],
                impl(config, { alias, path })
                {
                    config.pathAliases[alias] = configPath(path);
                }
            },

        '--define':
            {
                desc: 'Make string data available to code, eg. import VALUE from \'KEY\'',
                args: ['key', 'value'],
                impl(config, { key, value })
                {                    
                    config.definitions[key] = value;
                }
            },

        '--sourcemaps-disable':
            {
                desc: 'Don\'t create sourcemaps (which are normally enabled in dev mode and when debugger attached)',
                impl(config)
                {                    
                    config.output.pageJs.sourcemaps     = 'disable';
                    config.output.clientJs.sourcemaps   = 'disable';
                }
            },

        '--sourcemaps-enable':
            {
                desc: 'Create sourcemaps (which are normally disabled unless dev mode or when debugger attached)',
                impl(config)
                {                    
                    config.output.pageJs.sourcemaps     = 'enable';
                    config.output.clientJs.sourcemaps   = 'enable';
                }
            },

        '--quiet':
            {
                desc: 'Produce less log output',
                impl(config)
                {
                    config.quiet = true;
                }
            },

        '--pretty':
            {
                desc: 'Format output HTML, CSS, and JavaScript. Warning: Looks better, but assumes whitespace around some HTML tags is not significant. Use --pretty-ish if that is a problem.',
                impl(config)
                {
                    config.pretty = true;
                }
            },

        '--pretty-ish':
            {
                desc: 'Format output HTML, CSS, and JavaScript, preserving whitespace around all HTML tags.',
                impl(config)
                {
                    config.pretty = 'ish';
                }
            },

        '--help':
            {
                desc: 'Print basic help information and exit',
                impl()
                {
                    usage();
                    process.exit(0);
                }
            },
    };

export function usage()
{
    let optionsHelp = '';

    for (const flag in options)
    {
        const option = options[flag];

        if (option.advanced)
            continue;

        let argText = '';
        if (option.args)
            for (const argCamel of option.args)
                argText += ` <${camelToKebabCase(argCamel)}>`;

        optionsHelp += `\n`;
        optionsHelp += `    # ${option.desc}\n`;
        optionsHelp += `    ${flag}${argText}\n`;
    }

    // TOOD: Update usage to include yarn version
    console.log(
`NakedJSX ${packageInfo.version}

Usage:

    # ${options['--help'].desc}
    npx nakedjsx --help

    # Find and build NakedJSX pages in <pages-directory>
    npx nakedjsx <pages-directory> [options]

Options:
${optionsHelp}
Detailed documentation:

    https://nakedjsx.org/documentation/`
        );
}

function determineRootDir(args)
{
    if (args < 1)
        fatal('<pages-directory> is required.', usage);

    let rootDir = args.shift();

    if (rootDir === '--help')
    {
        options['--help'].impl();
        throw Error;
    }

    if (!fs.existsSync(rootDir))
        fatal(`Pages directory (${rootDir}) does not exist`);
    
    // Get rid of symlinks etc
    rootDir = fs.realpathSync(rootDir);

    if (!fs.statSync(rootDir).isDirectory())
        fatal(`Pages directory (${rootDir}) exists but is not a directory`);

    return rootDir;
}

function loadBaseConfig()
{
    //
    // Attempt to load config from pages dir
    //

    const config        = jsonClone(emptyConfig);
    const configFile    = path.join(rootDir, configFilename);

    if (!fs.existsSync(configFile))
        return config;

    try
    {
        merge(config, JSON.parse(fs.readFileSync(configFile)));
    }
    catch(error)
    {
        fatal('Failed to parse config file ' + error);
    }

    return config;
}

async function processCliArguments(args, config)
{
    //
    // Process command line options
    //

    while (args.length)
    {
        let flag    = args.shift();
        let option  = options[flag];

        if (!option)
        {
            // Flag not found, is it a deprecated alias?

            let found = false;
            
            for (const [replacementFlag, replacementOption] of Object.entries(options))
            {
                if (!replacementOption.deprecatedAlias)
                    continue;

                if (replacementOption.deprecatedAlias.includes(flag))
                {
                    warn(`Flag ${flag} is a deprecated alias of ${replacementFlag}. Please update your usage.`);

                    found   = true;
                    flag    = replacementFlag;
                    option  = replacementOption;

                    break;
                }
            }

            if (!found)
                fatal(`Unknown flag: ${flag}`, usage);
        }
        
        const optionArguments = {};
        for (const argCamel of option.args || [])
        {
            if (args.length == 0)
                fatal(`${flag} missing required <${camelToKebabCase(argCamel)}> argument`, usage);
            
            optionArguments[argCamel] = args.shift();
        }
        
        await option.impl(config, optionArguments);
    }
}

export async function main()
{
    // [0] == node, [1] == this script or something directly or indirectly importing it
    const args = process.argv.slice(2);

    rootDir = determineRootDir(args);

    const config = loadBaseConfig(rootDir);

    const configBefore = JSON.stringify(config);
    await processCliArguments(args, config);
    let configDirty = JSON.stringify(config) !== configBefore;

    if (configSave)
    {
        const configPath = path.join(rootDir, configFilename);
        log(`Writing config to ${configPath}`);

        fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
        configDirty = false;
    }

    //
    // If the config is dirty, pass it directly to @nakedjsx/core.
    // Otherwise we let it read the config file from root dir.
    //

    const options = {};

    if (configDirty)
        options.configOverride = config;

    const nakedJsx = new NakedJSX(rootDir, options);

    if (developmentMode)
        await nakedJsx.developmentMode();
    else
        await nakedJsx.build();
}
