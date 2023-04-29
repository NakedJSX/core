import { log } from '../util.mjs';

export function mapCachePlugin(plugin, cache = new Map())
{
    async function cacheImpl(partitionKey, key, fallback)
    {
        //
        // Assumes that nullish values are not legitimate cacheable rsults.
        //

        let partition = cache.get(partitionKey)
        if (!partition)
            cache.set(partitionKey, partition = new Map());

        const cachedResult = partition.get(key);
        if (cachedResult)
            return cachedResult;

        const result = await fallback();
        if (result)
            partition.set(key, result);

        return result;
    }

    const cachePlugin =
        new Proxy(
            plugin,
            {
                get(target, prop, receiver)
                {
                    const value = target[prop];

                    // We're only interested in function properties
                    if (!(value instanceof Function))
                        return value;

                    // If this proxy implements this method, return it
                    if (this[prop])
                        return this[prop];
                    
                    //
                    // Otherwise, return a generic wrapper for the original plugin functionality that
                    // warns if an unimplemented proxy method costs significant time.
                    //

                    return  async function(...args)
                            {
                                const beforeMs = new Date().getTime();
                                const result = value.apply(this === receiver ? target : this, args);
                                const durationMs = new Date().getTime() - beforeMs;

                                if (durationMs > 1)
                                {
                                    if (prop == 'load')
                                        log(`Unimplemented cache of method ${prop} ${args[0]} missed ${durationMs} ms`);
                                    else
                                        log(`Unimplemented cache of method ${prop} missed ${durationMs} ms`);
                                }
                                
                                return result;
                            };                    
                },

                async transform(code, ...args)
                {
                    return cacheImpl('transform', code, plugin.transform.bind(this, code, ...args));
                },

                async renderChunk(code, ...args)
                {
                    return cacheImpl('renderChunk', code, plugin.renderChunk.bind(this, code, ...args));
                }
            });
    
    return cachePlugin;
}