import { parentPort } from 'node:worker_threads';

// During job execution, is set to the job sent from the main thread.
export let currentJob = null;

// log via the main thread.
export function log(...args)
{
    parentPort.postMessage({ log: args.join(' ') });
}

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

        // Notify of completion
        parentPort.postMessage({ complete: true });
    });