#!/usr/bin/env node

//
// If the destination root folder is part of a package
// that depends on another @nakedjsx/core, then invoke that
// version's CLI directly. If not, then use this version.
//

import fs from 'node:fs';
import path from 'node:path';
import child_process from 'node:child_process';

import { main as bundledNakedJsxMain, usage } from './cli.mjs';
import { log, warn, fatal, absolutePath } from './util.mjs';

function determineRootDir(args)
{
    if (args < 1)
        fatal('<pages-directory> is required.', usage);

    const rootDir = args[0];

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

function findPackageJson(searchDir)
{
    searchDir = absolutePath(searchDir);

    while (searchDir)
    {
        const testFile = path.join(searchDir, 'package.json');
        if (fs.existsSync(testFile))
            return testFile;
        
        const nextSearchDir = path.normalize(path.join(searchDir, '..'));
        if (nextSearchDir === searchDir)
            return null;
        
        searchDir = nextSearchDir;
    }
}

function isDependencyOrDevDependency(packageFilePath, packageName)
{
    try
    {
        const pkg = JSON.parse(fs.readFileSync(packageFilePath));

        if (pkg.dependencies && pkg.dependencies[packageName])
            return true;

        if (pkg.devDependencies && pkg.devDependencies[packageName])
            return true;
    }
    catch(error)
    {
        warn(`Could not parse ${packageFilePath}`);
    }

    return false;
}

async function useTargetNakedJSX(rootDir, packageFilePath)
{
    log(`Using NakedJSX from ${packageFilePath} to build ${rootDir}`);

    const packageFileDir = path.dirname(packageFilePath);

    //
    // Note, using '.' intead of original source dir because we are changing cwd
    // Also we want to defend against infinite useTargetNakedJSX recursion so we
    // pass --nakedjsx-use-running.
    //

    const nakedJsxArguments = ['.', '--nakedjsx-use-running', '--cli-path-base', process.cwd()].concat(process.argv.slice(3));

    let command;
    let commandArguments;

    if (fs.existsSync(path.join(packageFileDir, 'yarn.lock')))
    {
        log('yarn.lock detected, assuming yarn');

        command = 'yarn';
        commandArguments = ['nakedjsx'].concat(nakedJsxArguments);
    }
    else if (fs.existsSync(path.join(packageFileDir, 'pnpm-lock.yaml')))
    {
        log('pnpm-lock.yaml detected, assuming pnpm');

        command = 'pnpm';
        commandArguments = ['exec', 'nakedjsx'].concat(nakedJsxArguments);
    }
    else if (fs.existsSync(path.join(packageFileDir, 'package-lock.json')))
    {
        log('package-lock.json detected, assuming npm');

        command = 'npx';
        commandArguments = ['nakedjsx'].concat(nakedJsxArguments);
    }
    else
    {
        warn('Target package not installed or dep mananger not detected, falling back to bundled NakedJSX (looked for yarn, pnpm, and npm)');
        return await useBundledNakedJSX(rootDir);
    }

    log(`Launching child process within ${rootDir}: ${command} ${commandArguments.join(' ')}`);

    child_process.spawnSync(
        command,
        commandArguments,
        {
            stdio: 'inherit',
            cwd: rootDir
        });
}

async function useBundledNakedJSX(rootDir)
{
    log(`Using bundled NakedJSX to build ${rootDir}`);

    await bundledNakedJsxMain();
}

export async function main()
{
    // [0] == node, [1] == this script
    const args = process.argv.slice(2);

    const rootDir = determineRootDir(args);

    // Have we been told to use the currently running @nakedjsx/core, rather than consider forwarding?
    if (args.length > 1 && args[1] === '--nakedjsx-use-running')
        return await useBundledNakedJSX(rootDir);

    const targetPackageFilePath = findPackageJson(rootDir);

    log(`Target package.json: ${targetPackageFilePath}`);

    // If the target folder isn't part of a package, use the bundled @nakedjsx/core
    if (!targetPackageFilePath)
        return await useBundledNakedJSX(rootDir);

    log(`${rootDir} is part of a package`);

    // If the target package doesn't directly depend on @nakedjsx/core, use the bundled @nakedjsx/core
    if (!isDependencyOrDevDependency(targetPackageFilePath, '@nakedjsx/core'))
        return await useBundledNakedJSX(rootDir);
    
    log(`${rootDir} is part of a package than depends on @nakedjsx/core`);

    //
    // The target does directly depend on @nakedjsx.core.
    //
    // The target dir might belong to the same package that the running 
    // @nakedjsx/core is a dependency of, or it might not.
    //

    const runningPackageFilePath = findPackageJson(path.join(path.dirname(process.argv[1]), '..'));
    log(`Running package.json: ${runningPackageFilePath}`);

    if (targetPackageFilePath === runningPackageFilePath)
        return await useBundledNakedJSX(rootDir);

    //
    // Finally, it appears that the target is in a package
    // unrelated to the one that the running version of @nakedjsx/core
    // is running from. Defer to the target installation.
    //

    log('Using target @nakedjsx/core');

    return await useTargetNakedJSX(rootDir, targetPackageFilePath);
}

await main();