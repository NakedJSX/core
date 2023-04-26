import path from 'node:path';

export const startTime = new Date().getTime();

export const log =
	(message) =>
	{
		const thisTime = new Date().getTime();
		const timeSinceStart = thisTime - startTime;

		const [, leadingNewlines] = message.match(/^(\n*)/);
		const followingMessage = message.substring(leadingNewlines.length);
		console.log(`${leadingNewlines}${timeSinceStart}: ${followingMessage}`);
	};

export const warn = console.warn.bind(console);

export const err = console.error.bind(console);

export function isExternalImport(id)
{
	return id.includes('/node_modules/') || id.includes('/.yarn/');
}

export function abort()
{
    let foundError = false;

    for (let message of arguments)
    {
        if (message instanceof Error)
            foundError = true;
        
        err(message);
    }
    
    // If we didn't log an error, make one so that we get a stack trace
    if (!foundError)
        err(new Error());

    process.abort();
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
        return path.normalize(process.cwd() + path.sep + absoluteOrRelativePath);
}