import path from 'node:path';

let benchmarkEnable = false;
let benchmarkStart  = null;

const boldOn        = process.stdout.isTTY ? '\x1b[1m'  : '';
const boldOff       = process.stdout.isTTY ? '\x1b[22m' : '';
const cursorUpStart = process.stdout.isTTY ? '\x1b[1F'  : '';
const eraseLine     = process.stdout.isTTY ? '\x1b[0K'  : '';

let promptClear     = `${cursorUpStart}${eraseLine}${cursorUpStart}`;
let promptText;

function setPrompt(newPrompt)
{
    if (process.stdout.isTTY)
    {
        const firstPrompt = !promptText;
        
        promptText = `\n${boldOn}${newPrompt}${boldOff}`;

        if (firstPrompt)
            log.quiet || console.log(`${promptText}`);
        else
            log.quiet || console.log(`${promptClear}${promptText}`)
    }
    else
        log.quiet || console.log(`\n${newPrompt}`);
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
        const timeSinceStart        = ((thisTime - benchmarkStart) / 1000).toFixed(3);
        const [, leadingNewlines]   = message.match(/^(\n*)/);
        const followingMessage      = message.substring(leadingNewlines.length);

        finalMessage = `${leadingNewlines}${timeSinceStart}: ${prefix}${followingMessage}`;
    } else {
        finalMessage = `${prefix}${message}`;
    }

    if (process.stdout.isTTY && promptText)
        return `${promptClear}\r${finalMessage}\n${promptText}`;
    else
        return `${finalMessage}`;
}

export function log(message)
{
    log.quiet || console.log(formatLogMessaage(message));
}

log.important =
    function(message)
    {
        // ignore the quiet setting
        console.log(formatLogMessaage(message))
    };

log.boldOn      = boldOn;
log.boldOff     = boldOff;
log.setPrompt   = setPrompt;
log.quiet       = false;

export function warn(message)
{
    console.warn(`${boldOn}${formatLogMessaage(message, 'WARNING: ')}${boldOff}`);
}

export function err(message)
{
    console.error(`${boldOn}${formatLogMessaage(message, 'ERROR: ')}${boldOff}`);
}

export function fatal(message, lastHurrahCallback)
{
    err(message);
    if (lastHurrahCallback)
        lastHurrahCallback();

    setPrompt('Exit due to error.');
    process.exit(1);
}

export function jsonClone(src)
{
    return JSON.parse(JSON.stringify(src));
}

export function convertToAlphaNum(value, digitSymbols)
{
    return convertToBase(value, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
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

export function absolutePath(absoluteOrRelativePath, relativeFrom)
{
    if (path.isAbsolute(absoluteOrRelativePath))
        return path.normalize(absoluteOrRelativePath);
    else
        return path.normalize(path.join(relativeFrom ?? process.cwd(), absoluteOrRelativePath));
}

export function camelToKebabCase(camel)
{
    return camel.replace(/[A-Z]/g, char => '-' + char.toLowerCase());
}

export function semicolonify(js)
{
    if (js.trim().endsWith(';'))
        return js;
    else
        return `${js};`;
}

export function merge(target, source, loopPreventor = new Set())
{
    loopPreventor.add(source);

    for (const [key, value] of Object.entries(source))
    {
        if (typeof target[key] === 'object' && typeof value === 'object')
        {
            if (loopPreventor.has(value))
                throw new Error(`Refusing to merge self-referencing object`);

            merge(target[key], value, loopPreventor);
        }
        else
            target[key] = value;
    }
}