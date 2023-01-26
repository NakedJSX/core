//
// Binding logging functions like this gives nice
// clickable locations in the vscode debug console.
//

export const log = console.log.bind(console);

export const warn = console.warn.bind(console);

export const err = console.error.bind(console);

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
