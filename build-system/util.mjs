import path from 'node:path';

let benchmarkEnable = false;
let benchmarkStart  = null;

const boldOn        = process.stdout.isTTY ? '\x1b[1m'  : '';
const boldOff       = process.stdout.isTTY ? '\x1b[22m' : '';
const cursorUpStart = process.stdout.isTTY ? '\x1b[1F'  : '';
const eraseLine     = process.stdout.isTTY ? '\x1b[0K'  : '';

const promptClear   = `${cursorUpStart}${eraseLine}${cursorUpStart}`;
let promptText      = '\n';

//
// Perform an initial dummy log so that the first prompt clear
// doesn't clear the terminal line before the first log output.
//

console.log('');

function setPrompt(newPrompt)
{
    if (process.stdout.isTTY)
    {
        promptText = `\n${boldOn}${newPrompt}${boldOff}`;
        console.log(`${promptClear}${promptText}`)
    }
    else
        console.log(`\n${newPrompt}`);
}

export function enableBenchmark(enable)
{
    if (enable)
    {
        if (benchmarkEnable)
            return;

        benchmarkEnable = true;
        benchmarkStart  = new Date().getTime();
    } else {
        benchmarkEnable = false;
        benchmarkStart  = null;
    }
}

function formatLogMessaage(message, prefix = '')
{
    if (typeof message !== 'string')
        message = '' + message;
    
    let finalMessage;
    
    if (benchmarkEnable)
    {
        const thisTime              = new Date().getTime();
        const timeSinceStart        = thisTime - benchmarkStart;
        const [, leadingNewlines]   = message.match(/^(\n*)/);
        const followingMessage      = message.substring(leadingNewlines.length);

        finalMessage = `${leadingNewlines}${timeSinceStart}: ${prefix}${followingMessage}`;
    } else {
        finalMessage = `${prefix}${message}`;
    }

    if (process.stdout.isTTY)
        return `${promptClear}\r${finalMessage}\n${promptText}`;
    else
        return `${leadingNewlines}${timeSinceStart}: ${prefix}${followingMessage}`;
}

export function log(message)
{
    console.log(formatLogMessaage(message));
}

log.boldOn      = boldOn;
log.boldOff     = boldOff;
log.setPrompt   = setPrompt;

export function warn(message)
{
    console.warn(`\x1b[1m${formatLogMessaage(message, 'WARNING: ')}\x1b[22m`);
}

export function err(message)
{
    console.error(`\x1b[1m${formatLogMessaage(message, 'ERROR: ')}\x1b[22m`);
}

export function fatal(message, lastHurrahCallback)
{
    err(message);
    if (lastHurrahCallback)
        lastHurrahCallback();
    process.exit(1);
}

export function isExternalImport(id)
{
    return id.includes('/node_modules/') || id.includes('/.yarn/');
}

export function convertToBase(value, digitSymbols)
{
    //
    // value:Number
    // digitSymbols:string
    //

    if (!Number.isInteger(value))
        throw Error(`convertToBase does not currently support non-integer values (${value})`);

    let n = Math.abs(value);

    const base = digitSymbols.length;
    let out = '';

    do
    {
        const digitIndex = n % base;
        out = digitSymbols.charAt(digitIndex) + out;
        n = (n - digitIndex) / base;
    }
    while (n);

    if (value < 0)
        return '-' + out;
    else
        return out;
}

export function removeQueryString(path)
{
    const queryIndex = path.indexOf('?');

    if (queryIndex != -1)
        return path.substring(0, queryIndex);
    else
        return path;
}

export function absolutePath(absoluteOrRelativePath)
{
    if (path.isAbsolute(absoluteOrRelativePath))
        return path.normalize(absoluteOrRelativePath);
    else
        return path.normalize(path.join(process.cwd(), absoluteOrRelativePath));
}

export function camelToKebabCase(camel)
{
    return camel.replace(/[A-Z]/g, char => '-' + char.toLowerCase());
}