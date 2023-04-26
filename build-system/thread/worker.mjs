import { workerData, parentPort } from 'node:worker_threads';

// During task execution, set to the task sent from the main thread.
export let currentTask = null;

// log via the main thread.
export function log(...args)
{
    parentPort.postMessage({ log: args.join(' ') });
}

// We need to make each subsequent import look unique ...
let importIndex = 0;

parentPort.on(
    'message',
    async (task) =>
    {
        // Make the current task available globally
        currentTask = task;

        // The code within the task is responsible for posting the result to the parent port.
        await import(`${task.taskJsFile}?importIndex=${importIndex++}`);

        // Remove hanging reference
        currentTask = null;
    });