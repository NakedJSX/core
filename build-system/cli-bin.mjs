#!/usr/bin/env node

//
// If the destination root folder is part of a package
// that depends on another @nakedjsx/core, then invoke that
// version's CLI directly. If not, then use this version.
//

import fs from 'node:fs';
import path from 'node:path';
import child_process from 'node:child_process';

import { main, usage } from './cli.mjs';
import { log, warn, fatal, absolutePath } from './util.mjs';

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
    // The cwd change is necessary to correctly invoke the @nakedjsx/core installed
    // around rootDir.
    //
    // For this reason we also override the --cli-path-base to cwd, which allows paths
    // passed on CLI to be relative to where the command was executed, not to the 
    // changed cwd after forwarding the invocation.
    //
    // We also want to defend against infinite useTargetNakedJSX recursion bugs so we
    // pass --do-not-forward, which forces the next @nakedjsx/core to build it.
    //

    const nakedJsxArguments =
        ['.', '--do-not-forward', '--cli-path-base', process.cwd()]
            .concat(process.argv.slice(3));

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
        fatal('Target package not installed or dep mananger not detected (looked for yarn, pnpm, and npm).');
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

export async function earlyMain()
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

    if (process.argv.length < 3)
        fatal('<pages-directory> is required.', usage);

    // [0] == node, [1] == this script, [2] == root dir
    const [rootDir, ...args] = process.argv.slice(2);

    if (rootDir === '--help')
    {
        usage();
        process.exit(0);
    }

    if (!fs.existsSync(rootDir))
        fatal(`Pages directory (${rootDir}) does not exist`);

    if (!fs.statSync(rootDir).isDirectory())
        fatal(`Pages directory (${rootDir}) exists but is not a directory`);

    // Have we been directly told to use the currently running @nakedjsx/core, rather than consider forwarding?
    if (args.length && args[0] === '--do-not-forward')
        return main();

    const targetPackageFilePath = findPackageJson(rootDir);

    // If the target folder isn't part of a package, use the bundled @nakedjsx/core
    if (!targetPackageFilePath)
        return main();

    // If the target package doesn't directly depend on @nakedjsx/core, use the bundled @nakedjsx/core
    if (!isDependencyOrDevDependency(targetPackageFilePath, '@nakedjsx/core'))
        return main();
    
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
        return main();

    //
    // Finally, it appears that the target is in a package
    // unrelated to the one that the running version of @nakedjsx/core
    // is running from. Defer to the target installation.
    //

    return forwardToTargetNakedJSX(rootDir, targetPackageFilePath);
}

await earlyMain();