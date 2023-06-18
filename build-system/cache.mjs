const defaultCacheLimit = 128;

/**
 * A key-value cache that limits the cache size by evicting the oldest entries.
 */
export class FifoCache
{
    #name;
    #limit;
    #map;
    #shouldWarn;

    constructor(name, limit, disableWarning)
    {
        this.name           = name;
        this.limit          = limit ?? defaultCacheLimit;
        this.#map           = new Map();
        this.#shouldWarn    = !disableWarning;
    }

    /** Return whether cache has value for key */
    has(key)
    {
        return this.#map.has(key);
    }

    /** Set value for key, and return value */
    set(key, value)
    {
        this.#map.set(key, value)

        if (this.#map.size > this.#limit)
        {
            if (this.#shouldWarn)
            {
                this.#shouldWarn = true;
                console.warn(`NakedJSX FifoCache cache size limit (${this.#limit}) exceeded for cache: ${this.$name}`);
            }

            // Remove the oldest entry to keep the cache size down
            this.#map.delete(this.#map.entries().next().value[0]);
        }

        return value;
    }

    /** Return cached value for key, or undefined */
    get(key)
    {
        return this.#map.get(key);
    }
}

/**
 * A key-value cache that limits the cache size by evicting in (least retrieved, oldest) order.
 */
export class LruCache
{
    #name;
    #limit;
    #map;
    #shouldWarn;

    constructor(name, limit, disableWarning)
    {
        this.name           = name;
        this.limit          = limit ?? defaultCacheLimit;
        this.#map           = new Map();
        this.#shouldWarn    = !disableWarning;
    }

    /** Return whether cache has value for key */
    has(key)
    {
        return this.#map.has(key);
    }

    /** Set value for key, and return value */
    set(key, value)
    {
        this.#map.set(key, value)

        if (this.#map.size > this.#limit)
        {
            if (this.#shouldWarn)
            {
                this.#shouldWarn = false;
                console.warn(`NakedJSX LruCache cache size limit (${this.#limit}) exceeded for cache: ${this.#name}`);
            }

            // Remove the least-used entry to keep the cache size down
            this.#map.delete(this.#map.entries().next().value[0]);
        }

        return value;
    }

    /** Return cached value for key, or undefined */
    get(key)
    {
        const value = this.#map.get(key);

        if (value !== undefined)
        {
            // delete and re-add will update the insertion order
            this.#map.delete(key);
            this.#map.set(key, value);
        }

        return value;
    }
}