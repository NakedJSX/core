#!/usr/bin/env node

//
// If the destination root folder is part of a package
// that depends on another @nakedjsx/core, then invoke that
// version's CLI directly. If not, then use this version.
//

import fs from 'node:fs';
import path from 'node:path';
import child_process from 'node:child_process';

import { main as runningNakedJsxMain, usage } from './cli.mjs';
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

async function forwardToTargetNakedJSX(rootDir, packageFilePath)
{
    log(`Forwarding to NakedJSX from ${packageFilePath} to build ${rootDir}`);

    const packageFileDir = path.dirname(packageFilePath);

    //
    // Note, we use '.' intead of the original source dir because we are changing cwd.
    // Also we want to defend against infinite useTargetNakedJSX recursion so we pass
    // --nakedjsx-use-running.
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
        fatal('Target package not installed or dep mananger not detected (looked for yarn, pnpm, and npm). Use --nakedjsx-use-running to build using the version of @nakedjsx/core installed with the npx command.');
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

export async function main()
{
    //
    // Depending on cwd, 'npx nakedjsx <path>' will either invoke a globally
    // installed @nakedjsx/core, or the 'nakedjsx' binary exposed by an
    // installation of @nakedjsx/core that cwd resides in.
    //
    // A decision to be made - allow the currently executing instalation of
    // NakedJSX to handle the build, or invoke the version of NakedJSX
    // installed in a package that contains the folder to be built.
    //
    // Getting this right means you can always use 'npx nakedjsx'
    // and the build result will be the same, regardless of the cwd.
    //

    // [0] == node, [1] == this script
    const args = process.argv.slice(2);

    const rootDir = determineRootDir(args);

    // Have we been directly told to use the currently running @nakedjsx/core, rather than consider forwarding?
    if (args.length > 1 && args[1] === '--nakedjsx-use-running')
        return runningNakedJsxMain();

    const targetPackageFilePath = findPackageJson(rootDir);

    // If the target folder isn't part of a package, use the bundled @nakedjsx/core
    if (!targetPackageFilePath)
        return runningNakedJsxMain();

    // If the target package doesn't directly depend on @nakedjsx/core, use the bundled @nakedjsx/core
    if (!isDependencyOrDevDependency(targetPackageFilePath, '@nakedjsx/core'))
        return runningNakedJsxMain();
    
    //
    // The target does directly depend on @nakedjsx/core.
    //
    // If the currently running nakedjsx is somewhere under the dir that
    // holds the target package file, then we can keep running.
    //
    // Otherwise, we forward this invocation to the @nakedjsx/core
    // installation within the target package.
    //

    if (process.argv[1].startsWith(path.dirname(targetPackageFilePath)))
        return runningNakedJsxMain();

    //
    // Finally, it appears that the target is in a package
    // unrelated to the one that the running version of @nakedjsx/core
    // is running from. Defer to the target installation.
    //

    return forwardToTargetNakedJSX(rootDir, targetPackageFilePath);
}

await main();