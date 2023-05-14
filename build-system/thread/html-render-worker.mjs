import { parentPort } from 'node:worker_threads';

// During job execution, is set to the job sent from the main thread.
export let currentJob = null;

// log via the main thread.
export function log(...args)
{
    parentPort.postMessage({ log: args.join(' ') });
}

const cache = new Map();

// Return a named map that persists beween pages and incremental builds
export function getCache(name)
{
    let result = cache.get(name);

    if (!result)
    {
        result = new Map();
        cache.set(name, result);
    }
    
    return result;
}

// take note of the keys in the default global scope
const standardGlobalKeys = new Set(Object.keys(global));

// We need to make each subsequent import of the same filename look unique ...
let importIndex = 0;

parentPort.on(
    'message',
    async (job) =>
    {
        // Make the current job available globally
        currentJob = job;

        // The code within the job (Page.Render()) is responsible for passing rendered pages to the parent port.
        await import(`${job.page.htmlJsFileOut}?breakCache=${importIndex++}`);

        // Remove hanging reference
        currentJob = null;

        // Remove anything added to global scope
        for (let key of Object.keys(global))
            if (!standardGlobalKeys.has(key))
                delete global[key];

        // Notify of completion
        parentPort.postMessage({ complete: true });
    });