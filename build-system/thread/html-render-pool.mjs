// Implementation adapted from: https://nodejs.org/api/async_context.html#using-asyncresource-for-a-worker-thread-pool

import { dirname } from 'node:path';
import { AsyncResource } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';

import { log as utilLog } from '../util.mjs';

const kTaskInfo = Symbol('kTaskInfo');
const kWorkerFreedEvent = Symbol('kWorkerFreedEvent');

class HtmlRenderTaskInfo extends AsyncResource
{
    #job;
    #callbacks;

    constructor(job, callbacks)
    {
        super('HtmlRenderTaskInfo');
        this.#job = job;
        this.#callbacks = callbacks;
    }

    get job()
    {
        return this.#job;
    }

    onRendered(htmlFilePath, htmlContent)
    {
        //
        // Calling the callback in this way uses the execution context
        // of the code that created the job, rather than that of the Worker.
        //
        // This means that stack traces will contain the frames that created
        // the job, rather than a bunch of worker pool plumbing.
        //
        // Set a break point in this.#callbacks.onRendered to see the result.
        //

        this.runInAsyncScope(this.#callbacks.onRendered, null, htmlFilePath, htmlContent);
    }

    onComplete(error)
    {
        this.runInAsyncScope(this.#callbacks.onComplete, null, error);
        this.emitDestroy();
    }
}

export default class HtmlRenderPool extends EventEmitter
{
    constructor(numThreads)
    {
        super();

        this.numThreads     = numThreads;
        this.workers        = [];
        this.freeWorkers    = [];
        this.tasks          = [];

        this.log(`HtmlRenderPool creating ${numThreads} thread${numThreads > 1 ? 's' : ''}`)

        for (let i = 0; i < numThreads; i++)
            this.addNewWorker();

        //
        // Any time the kWorkerFreedEvent is emitted, dispatch
        // the next task pending in the queue, if any.
        //

        this.on(
            kWorkerFreedEvent,
            () =>
            {
                if (this.tasks.length > 0)
                    this.runTask(this.tasks.shift());
            });
    }

    addNewWorker()
    {
        const worker =
            new Worker(
                new URL(dirname(import.meta.url) + '/html-render-worker.mjs')
                );
        
        worker.on(
            'message',
            (messageObject) =>
            {
                if (messageObject.log)
                {
                    this.log(messageObject.log);
                    return;
                }

                if (messageObject.rendered)
                {
                    worker[kTaskInfo].onRendered(messageObject.rendered);
                    return;
                }
                
                if (messageObject.complete)
                {
                    worker[kTaskInfo].onComplete(null);
                    worker[kTaskInfo] = null;
                    
                    this.freeWorkers.push(worker);
                    this.emit(kWorkerFreedEvent);
                    return;
                }

                this.log("Worker posted unhandled mesage: " + JSON.stringify(messageObject));
            });

        worker.on(
            'error',
            (error) =>
            {
                this.log(`Worker posted error: ${error}`);

                if (worker[kTaskInfo])
                    worker[kTaskInfo].onComplete(error);
                else
                    this.emit('error', error);

                // Remove the worker from the list and start a new one
                this.workers.splice(this.workers.indexOf(worker), 1);
                this.addNewWorker();
            });
        
        this.workers.push(worker);
        this.freeWorkers.push(worker);
        this.emit(kWorkerFreedEvent);
    }

    render(job, callbacks)
    {
        this.runTask(new HtmlRenderTaskInfo(job, callbacks));
    }

    runTask(task)
    {
        if (this.freeWorkers.length == 0)
        {
            this.tasks.push(task);
            return;
        }

        const worker = this.freeWorkers.pop();
        worker[kTaskInfo] = task;
        worker.postMessage(task.job);
    }

    close()
    {
        for (const worker of this.workers)
            worker.terminate();
    }

    log(message)
    {
        utilLog(`HtmlRenderPool: ${message}`);
    }
}