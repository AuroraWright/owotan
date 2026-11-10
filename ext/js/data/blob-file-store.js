/*
 * Copyright (C) 2026  Yomitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

const STORE_NAME = 'entries';

/**
 * Keeps sets of files as Blobs in IndexedDB, for Safari. Safari on iOS gives an extension a new origin each
 * time it starts, and moves only the IndexedDB and local storage data of the old origin to the new one, so
 * files in the origin private file system are lost when Safari restarts.
 * @template [TRecord=null]
 */
export class BlobFileStore {
    /**
     * @param {string} name The name of the database.
     */
    constructor(name) {
        /** @type {string} */
        this._name = name;
        /** @type {?Promise<IDBDatabase>} */
        this._databasePromise = null;
    }

    /**
     * @returns {Promise<import('blob-file-store').Entry<TRecord>[]>}
     */
    async getAll() {
        return await this._run('readonly', (store) => store.getAll());
    }

    /**
     * @param {string} id
     * @returns {Promise<?import('blob-file-store').Entry<TRecord>>}
     */
    async get(id) {
        return (await this._run('readonly', (store) => store.get(id))) ?? null;
    }

    /**
     * Gets several entries in one transaction.
     * @param {string[]} ids
     * @returns {Promise<(?import('blob-file-store').Entry<TRecord>)[]>} The entries, in the order of `ids`, with
     *   `null` for each that is missing.
     */
    async getMany(ids) {
        if (ids.length === 0) { return []; }
        const results = await this._runMany('readonly', (store) => ids.map((id) => store.get(id)));
        return results.map((result) => result ?? null);
    }

    /**
     * Stores an entry, replacing the one with its id. The files are written by when this resolves.
     * @param {import('blob-file-store').Entry<TRecord>} entry
     */
    async put(entry) {
        await this._run('readwrite', (store) => store.put(entry));
    }

    /**
     * @param {string} id
     */
    async delete(id) {
        await this._run('readwrite', (store) => store.delete(id));
    }

    // Private

    /**
     * @template TResult
     * @param {IDBTransactionMode} mode
     * @param {(store: IDBObjectStore) => IDBRequest<TResult>} createRequest
     * @returns {Promise<TResult>} The request's result, once its transaction completes.
     */
    async _run(mode, createRequest) {
        const [result] = await this._runMany(mode, (store) => [createRequest(store)]);
        return result;
    }

    /**
     * @template TResult
     * @param {IDBTransactionMode} mode
     * @param {(store: IDBObjectStore) => IDBRequest<TResult>[]} createRequests
     * @returns {Promise<TResult[]>} The requests' results, once their transaction completes.
     */
    async _runMany(mode, createRequests) {
        const database = await this._getDatabase();
        return await new Promise((resolve, reject) => {
            const transaction = database.transaction(STORE_NAME, mode);
            const requests = createRequests(transaction.objectStore(STORE_NAME));
            transaction.addEventListener('complete', () => resolve(requests.map((request) => request.result)));
            transaction.addEventListener('error', () => reject(transaction.error ?? requests.find((request) => request.error !== null)?.error));
            transaction.addEventListener('abort', () => reject(transaction.error ?? new Error('Transaction aborted')));
        });
    }

    /**
     * @returns {Promise<IDBDatabase>}
     */
    _getDatabase() {
        if (this._databasePromise === null) {
            this._databasePromise = new Promise((resolve, reject) => {
                const request = indexedDB.open(this._name, 1);
                request.addEventListener('upgradeneeded', () => {
                    request.result.createObjectStore(STORE_NAME, {keyPath: 'id'});
                });
                request.addEventListener('success', () => resolve(request.result));
                request.addEventListener('error', () => reject(request.error));
            });
            this._databasePromise.catch(() => { this._databasePromise = null; });
        }
        return this._databasePromise;
    }
}

/**
 * Reads smaller than this are served from blocks, which are read whole and cached; larger ones are read directly.
 */
const DIRECT_READ_SIZE = 64 * 1024;
/**
 * The size of the blocks by default.
 */
const DEFAULT_BLOCK_SIZE = 64 * 1024;
/**
 * How much is cached by default, across all handles, in bytes.
 */
const DEFAULT_CACHE_SIZE = 256 * DEFAULT_BLOCK_SIZE;
/**
 * The most read ahead at once by default, in bytes.
 */
const DEFAULT_READ_AHEAD_SIZE = 128 * DEFAULT_BLOCK_SIZE;
/**
 * The most bytes between two blocks read ahead that are read with them, so that they are read as one slice of their
 * Blob: each slice costs Safari about as much as reading this many bytes.
 */
const MAX_READ_AHEAD_GAP = 32 * 1024;
/**
 * The most that one `FileReaderSync` read reads, so a large read does not make a copy of its size.
 */
const MAX_READ_SIZE = 8 * 1024 * 1024;

/**
 * Reads a Blob in place of an origin private file system sync access handle, for the file systems of hoshidicts
 * and MeCab (dev/hoshidicts/library-opfs.jslib), which read only the parts of a file they need. Reads are
 * synchronous, so this only works in a worker.
 *
 * Each read through `FileReaderSync` costs about a millisecond and a half in Safari however little it reads, and
 * opening a dictionary makes dozens of reads of a few bytes, so small reads go through a cache of blocks. The
 * Blobs of stored files never change, so the blocks never go stale. hoshidicts also says which ranges it will
 * read next (`advise`), and the blocks of those of all handles are read together. A handle can also be given the
 * whole content of its Blob, read with others by `readBlobs`, to read from until it is released.
 */
export class BlobReadHandle {
    /**
     * @param {Blob} blob
     * @param {?Uint8Array} [content] The content of `blob`, if it has been read already.
     */
    constructor(blob, content = null) {
        /** @type {Blob} */
        this._blob = blob;
        /** @type {?Uint8Array} */
        this._content = content;
        /** @type {?FileReaderSync} */
        this._reader = null;
        /** @type {number} */
        this._id = nextHandleId++;
    }

    /**
     * @returns {number}
     */
    getSize() {
        return this._blob.size;
    }

    /**
     * @param {Uint8Array} buffer
     * @param {{at: number}} options
     * @returns {number} The number of bytes read.
     */
    read(buffer, {at}) {
        const end = Math.min(at + buffer.byteLength, this._blob.size);
        if (end <= at) { return 0; }
        if (this._content !== null) {
            buffer.set(this._content.subarray(at, end));
            return end - at;
        }
        let position = at;
        if (end - at >= DIRECT_READ_SIZE) {
            // In parts, as each read makes a copy, and hoshidicts reads a whole archive at once.
            while (position < end) {
                const content = new Uint8Array(this._getReader().readAsArrayBuffer(this._blob.slice(position, Math.min(position + MAX_READ_SIZE, end))));
                if (content.byteLength === 0) { break; }
                buffer.set(content, position - at);
                position += content.byteLength;
            }
            return position - at;
        }
        while (position < end) {
            const blockStart = position - (position % blockSize);
            const block = this._getBlock(blockStart);
            const count = Math.min(end, blockStart + block.byteLength) - position;
            buffer.set(block.subarray(position - blockStart, position - blockStart + count), position - at);
            position += count;
        }
        return end - at;
    }

    /**
     * Notes that a range will be read soon. Its blocks that are not cached are read together with those of the
     * other ranges noted, of any handle, when a block that is not cached is next read.
     * @param {number} offset
     * @param {number} length
     */
    advise(offset, length) {
        if (this._content !== null) { return; }
        const end = Math.min(offset + length, this._blob.size);
        for (let start = offset - (offset % blockSize); start < end && advisedBlocks.size < maxReadAheadBlocks; start += blockSize) {
            const key = `${this._id}:${start}`;
            if (!cachedBlocks.has(key)) { advisedBlocks.set(key, {id: this._id, blob: this._blob, start}); }
        }
    }

    /**
     * Drops the content the handle was given, so that later reads read the Blob.
     */
    release() {
        this._content = null;
    }

    // Private

    /**
     * @returns {FileReaderSync}
     */
    _getReader() {
        if (this._reader === null) { this._reader = new FileReaderSync(); }
        return this._reader;
    }

    /**
     * @param {number} start
     * @returns {Uint8Array}
     */
    _getBlock(start) {
        const key = `${this._id}:${start}`;
        let block = cachedBlocks.get(key);
        if (typeof block !== 'undefined') {
            // Moved to the end, as the most recently used
            cachedBlocks.delete(key);
            cachedBlocks.set(key, block);
            return block;
        }
        if (advisedBlocks.size > 0) {
            advisedBlocks.set(key, {id: this._id, blob: this._blob, start});
            try {
                readAdvisedBlocks();
            } catch (e) {
                // Read on its own
            }
            block = cachedBlocks.get(key);
            if (typeof block !== 'undefined') { return block; }
        }
        block = new Uint8Array(this._getReader().readAsArrayBuffer(this._getBlockBlob(start)));
        cacheBlock(key, block);
        return block;
    }

    /**
     * @param {number} start
     * @returns {Blob}
     */
    _getBlockBlob(start) {
        return this._blob.slice(start, Math.min(start + blockSize, this._blob.size));
    }
}

/**
 * Reads the blocks of the ranges handles were told of in one read (`BlobReadHandle.advise`), and caches them. The
 * blocks of a handle near each other are read as one slice of its Blob, with what lies between them
 * (`MAX_READ_AHEAD_GAP`).
 */
function readAdvisedBlocks() {
    const advised = [...advisedBlocks.values()].sort((a, b) => (a.id - b.id) || (a.start - b.start));
    advisedBlocks.clear();
    /** @type {{id: number, blob: Blob, start: number, end: number}[]} */
    const runs = [];
    for (const {id, blob, start} of advised) {
        const run = runs.at(-1);
        if (typeof run !== 'undefined' && run.id === id && start - run.end <= MAX_READ_AHEAD_GAP) {
            run.end = start + blockSize;
        } else {
            runs.push({id, blob, start, end: start + blockSize});
        }
    }
    const contents = readBlobs(runs.map(({blob, start, end}) => blob.slice(start, Math.min(end, blob.size))));
    for (let i = 0; i < runs.length; ++i) {
        const {id, start} = runs[i];
        const content = contents[i];
        for (let position = 0; position < content.byteLength; position += blockSize) {
            // A copy, so that the buffer of all of them is not kept while one is cached
            cacheBlock(`${id}:${start + position}`, content.slice(position, position + blockSize));
        }
    }
}

/**
 * @param {string} key
 * @param {Uint8Array} block
 */
function cacheBlock(key, block) {
    // Past its size by up to what is read ahead at once, so that what a request reads ahead stays until it is read,
    // until the request ends (trimBlockCache)
    if (cachedBlocks.size >= maxCachedBlocks + maxReadAheadBlocks) {
        cachedBlocks.delete(/** @type {string} */ (cachedBlocks.keys().next().value));
    }
    cachedBlocks.set(key, block);
}

/**
 * Reads several Blobs whole, a few at a time in one `FileReaderSync` read of a Blob of them, which is many times
 * faster in Safari than reading each, as each read costs about a millisecond and a half however little it reads.
 * Only works in a worker.
 * @param {Blob[]} blobs
 * @returns {Uint8Array[]} The content of each Blob, in order. Those read together share a buffer, which is kept
 *   while any of them is.
 * @throws {Error} If the Blobs could not be read whole.
 */
export function readBlobs(blobs) {
    const reader = new FileReaderSync();
    /** @type {Uint8Array[]} */
    const results = [];
    let start = 0;
    while (start < blobs.length) {
        // Up to MAX_READ_SIZE at once, or one larger Blob
        let end = start + 1;
        let size = blobs[start].size;
        while (end < blobs.length && size + blobs[end].size <= MAX_READ_SIZE) {
            size += blobs[end].size;
            ++end;
        }
        const content = new Uint8Array(reader.readAsArrayBuffer(new Blob(blobs.slice(start, end))));
        if (content.byteLength !== size) { throw new Error('Could not read the whole content of the files'); }
        let position = 0;
        for (let i = start; i < end; ++i) {
            const blobSize = blobs[i].size;
            results.push(content.subarray(position, position + blobSize));
            position += blobSize;
        }
        start = end;
    }
    return results;
}

/**
 * Sets how `BlobReadHandle` reads and caches in this context, across all handles. The defaults suit the memory of
 * phones.
 * @param {{size: number, blockSize: number, readAheadSize: number}} options How much is cached between requests, in
 *   blocks of what size, and how much is read ahead at once, all in bytes. The cache holds at least one block, and
 *   holds more by up to what is read ahead at once until `trimBlockCache`. Smaller blocks read less that is not
 *   needed, so more of what is fits: the ranges read ahead are often records of a few hundred bytes, apart from each
 *   other. Blocks are at most `DIRECT_READ_SIZE`.
 */
export function setBlockCache({size, blockSize: newBlockSize, readAheadSize}) {
    if (newBlockSize !== blockSize) {
        // The blocks cached are of the old size
        cachedBlocks.clear();
        advisedBlocks.clear();
        blockSize = Math.min(newBlockSize, DIRECT_READ_SIZE);
    }
    maxCachedBlocks = Math.max(Math.floor(size / blockSize), 1);
    maxReadAheadBlocks = Math.max(Math.floor(readAheadSize / blockSize), 1);
    trimBlockCache();
}

/**
 * Drops the least recently used blocks past the size of the cache, which what one request read ahead can take it
 * past. Called after each request.
 */
export function trimBlockCache() {
    while (cachedBlocks.size > maxCachedBlocks) {
        cachedBlocks.delete(/** @type {string} */ (cachedBlocks.keys().next().value));
    }
}

/**
 * How many blocks are cached between requests, across all handles (`setBlockCache`).
 * @type {number}
 */
let maxCachedBlocks = DEFAULT_CACHE_SIZE / DEFAULT_BLOCK_SIZE;
/**
 * The most blocks read ahead at once, for the ranges handles are told of (`BlobReadHandle.advise`). A lookup in many
 * dictionaries tells of many, and those past this are read one at a time.
 * @type {number}
 */
let maxReadAheadBlocks = DEFAULT_READ_AHEAD_SIZE / DEFAULT_BLOCK_SIZE;
/**
 * The size of the blocks read and cached (`setBlockCache`).
 * @type {number}
 */
let blockSize = DEFAULT_BLOCK_SIZE;
/** @type {number} */
let nextHandleId = 0;
/**
 * The blocks `BlobReadHandle` read, by handle and position, from the least recently used.
 * @type {Map<string, Uint8Array>}
 */
const cachedBlocks = new Map();
/**
 * The blocks of the ranges handles were told of that are not cached, by handle and position, with the id and Blob of
 * their handle.
 * @type {Map<string, {id: number, blob: Blob, start: number}>}
 */
const advisedBlocks = new Map();
