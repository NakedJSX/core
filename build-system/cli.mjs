
//
// This tool is just a simple config building and invocation wrapper.
//

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import { NakedJSX } from './nakedjsx.mjs';
import { log, fatal, camelToKebabCase, absolutePath } from './util.mjs';

const configFilename = '.nakedjsx.json';
const emptyConfig =
    {
        importMapping:              {},
        browserslistTargetQuery:    'defaults',
        plugins:                    []
    };

let developmentMode = false;    // --dev
let configSave      = false;    // --config-save

let args;
let rootDir;
let config;

function configPath(filepath)
{
    //
    // Convert an absolute or relateive to cwd path to one
    // relative to the root dir config file..
    //

    return path.relative(rootDir, absolutePath(filepath));
}

const options =
    {
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
        
        '--output-dir':
            {
                desc: 'The build output will be placed here',
                args: ['path'],
                impl(config, { path })
                {
                    config.outputDir = configPath(path)
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
                desc: 'Enable plugin such as @nakedjsx/plugin-asset-image.',
                args: ['pluginPackageNameOrPath'],
                async impl(config, { pluginPackageNameOrPath })
                {
                    let finalPath;

                    if (fs.existsSync(pluginPackageNameOrPath))
                        finalPath = configPath(pluginPackageNameOrPath);
                    else
                        // hopefully a package name like @nakedjsx/plugin-asset-image
                        finalPath = pluginPackageNameOrPath;

                    if (!config.plugins.includes(finalPath))
                        config.plugins.push(finalPath);
                }
            },

        '--alias-source':
            {
                desc: 'Soucecode import path alias, eg. import something from \'$SRC/something.mjs\'',
                args: ['alias', 'sourceImportDirectory'],
                impl(config, { alias, sourceImportDirectory })
                {
                    config.importMapping[alias] =
                        {
                            type: 'source',
                            path: configPath(sourceImportDirectory)
                        };
                }
            },

        '--alias-asset':
            {
                desc: 'Asset import path alias, eg. import logo_uri_path from \'$ASSET/logo.png\'',
                args: ['alias', 'assetImportDirectory'],
                impl(config, { alias, assetImportDirectory })
                {
                    config.importMapping[alias] =
                        {
                            type: 'asset',
                            path: configPath(assetImportDirectory)
                        };
                }
            },

        '--define':
            {
                desc: 'Make string data available to code, eg. import VALUE from \'KEY\'',
                args: ['key', 'value'],
                impl(config, { key, value })
                {                    
                    config.importMapping[key] = { type: 'definition', value };
                }
            },

        '--help':
            {
                desc: 'Print basic help information and exit',
                impl()
                {
                    usage();
                    process.exit();
                }
            },
    };

function usage()
{
    let optionsHelp = '';

    for (const flag in options)
    {
        const option = options[flag];

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
`
Usage:

    # ${options['--help'].desc}
    npx nakedjsx --help

    # Find and build NakedJSX pages in <pages-directory>
    npx nakedjsx <pages-directory> [options]

Options:
${optionsHelp}`);
}

function determineRootDir()
{
    if (args < 1)
        fatal('<pages-directory> is required.', usage);

    const rootDir = args.shift();

    if (rootDir === '--help')
    {
        options['--help'].impl();
        throw Error;
    }

    if (!fs.existsSync(rootDir))
        fatal(`Pages directory (${rootDir}) does not exist`);

    if (!fs.statSync(rootDir).isDirectory())
        fatal(`Pages directory (${rootDir}) exists but is not a directory`);

    log(`Pages directory is ${rootDir}`);

    return rootDir;
}

function loadBaseConfig()
{
    //
    // Attempt to load config from pages dir
    //

    const config = Object.assign({}, emptyConfig);
    const configFile = rootDir + path.sep + configFilename;

    if (!fs.existsSync(configFile))
    {
        log(`No config found at ${configFile}`);
        return config;
    }

    log(`Loading config from ${configFile}`);

    try
    {
        Object.assign(config, JSON.parse(fs.readFileSync(configFile)));
    }
    catch(error)
    {
        fatal('Failed to parse config file ' + error);
    }

    return config;
}

async function processCliArguments()
{
    //
    // Process command line options
    //

    while (args.length)
    {
        const flag = args.shift();
        const option = options[flag];

        if (!option)
            fatal(`Unknown flag: ${flag}`, usage);
        
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
    args = process.argv.slice(2);

    rootDir = determineRootDir(args)
    config  = loadBaseConfig(rootDir);

    const configBefore = JSON.stringify(config);
    await processCliArguments(args, config);
    let configDirty = JSON.stringify(config) !== configBefore;

    if (configSave)
    {
        const configPath = rootDir + path.sep + configFilename;
        log(`Writing config to ${configPath}`);

        fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
        configDirty = false;
    }

    //
    // If the config is dirty, pass it directly to @nakedjsx/core.
    // Otherwise we let it read the config file from root dir.
    //

    let nakedJsx;

    if (configDirty)
        nakedJsx = new NakedJSX(rootDir, { configOverride: config });
    else
        nakedJsx = new NakedJSX(rootDir);

    if (developmentMode)
        await nakedJsx.developmentMode();
    else
        await nakedJsx.build();
}
