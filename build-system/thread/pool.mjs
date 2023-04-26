// Implementation taken from: https://nodejs.org/api/async_context.html#using-asyncresource-for-a-worker-thread-pool

import { dirname } from 'node:path';
import { AsyncResource } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';

import { log as utilLog } from '../util.mjs';

const kTaskInfo = Symbol('kTaskInfo');
const kWorkerFreedEvent = Symbol('kWorkerFreedEvent');

class WorkerPoolTaskInfo extends AsyncResource
{
    constructor(callback)
    {
        super('WorkerPoolTaskInfo');
        this.callback = callback;
    }

    done(err, result)
    {
        this.runInAsyncScope(this.callback, null, err, result);
        this.emitDestroy();  // `TaskInfo`s are used only once.
    }
}

export default class WorkerPool extends EventEmitter
{
    constructor(name, numThreads)
    {
        super();
        this.name           = name;
        this.numThreads     = numThreads;
        this.workers        = [];
        this.freeWorkers    = [];
        this.tasks          = [];

        this.log(`Creating pool of ${numThreads} thread${numThreads > 1 ? 's' : ''}`)

        for (let i = 0; i < numThreads; i++)
            this.addNewWorker();

        // Any time the kWorkerFreedEvent is emitted, dispatch
        // the next task pending in the queue, if any.
        this.on(
            kWorkerFreedEvent,
            () => {
                if (this.tasks.length > 0)
                {
                    const { task, callback } = this.tasks.shift();
                    this.runTask(task, callback);
                }
            });
    }

    addNewWorker()
    {
        const worker =
            new Worker(
                new URL(dirname(import.meta.url) + '/worker.mjs'),
                { workerData: {} });
        
        worker.on(
            'message',
            (result) => {
                if (result.log)
                {
                    this.log(result.log);
                    return;
                }

                // log("Worker posted mesage: " + JSON.stringify(result));

                // In case of success: Call the callback that was passed to `runTask`,
                // remove the `TaskInfo` associated with the Worker, and mark it as free
                // again.
                worker[kTaskInfo].done(null, result);
                worker[kTaskInfo] = null;
                this.freeWorkers.push(worker);
                this.emit(kWorkerFreedEvent);
            });

        worker.on(
            'error',
            (err) =>
            {
                this.log(`Worker posted error: ${err}`);

                // In case of an uncaught exception: Call the callback that was passed to
                // `runTask` with the error.
                if (worker[kTaskInfo])
                    worker[kTaskInfo].done(err, null);
                else
                    this.emit('error', err);

                // Remove the worker from the list and start a new Worker to replace the
                // current one.
                this.workers.splice(this.workers.indexOf(worker), 1);
                this.addNewWorker();
            });
        this.workers.push(worker);
        this.freeWorkers.push(worker);
        this.emit(kWorkerFreedEvent);
    }

    runTask(task, callback)
    {
        if (this.freeWorkers.length === 0)
        {
            // No free threads, wait until a worker thread becomes free.
            this.tasks.push({ task, callback });
            return;
        }

        const worker = this.freeWorkers.pop();
        worker[kTaskInfo] = new WorkerPoolTaskInfo(callback);
        worker.postMessage(task);
    }

    close()
    {
        for (const worker of this.workers)
            worker.terminate();
    }

    log(message)
    {
        utilLog(`Worker Pool (${this.name}): ${message}`);
    }
}