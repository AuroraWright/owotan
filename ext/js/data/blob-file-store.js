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
        const database = await this._getDatabase();
        return await new Promise((resolve, reject) => {
            const transaction = database.transaction(STORE_NAME, mode);
            const request = createRequest(transaction.objectStore(STORE_NAME));
            transaction.addEventListener('complete', () => resolve(request.result));
            transaction.addEventListener('error', () => reject(transaction.error ?? request.error));
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
 * Reads smaller than this are served from blocks of this size, which are read whole and cached.
 */
const BLOCK_SIZE = 64 * 1024;
/**
 * How many blocks are cached, across all handles.
 */
const MAX_CACHED_BLOCKS = 256;
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
 * Blobs of stored files never change, so the blocks never go stale.
 */
export class BlobReadHandle {
    /**
     * @param {Blob} blob
     */
    constructor(blob) {
        /** @type {Blob} */
        this._blob = blob;
        /** @type {FileReaderSync} */
        this._reader = new FileReaderSync();
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
        let position = at;
        if (end - at >= BLOCK_SIZE) {
            // In parts, as each read makes a copy, and hoshidicts reads a whole archive at once.
            while (position < end) {
                const content = new Uint8Array(this._reader.readAsArrayBuffer(this._blob.slice(position, Math.min(position + MAX_READ_SIZE, end))));
                if (content.byteLength === 0) { break; }
                buffer.set(content, position - at);
                position += content.byteLength;
            }
            return position - at;
        }
        while (position < end) {
            const blockStart = position - (position % BLOCK_SIZE);
            const block = this._getBlock(blockStart);
            const count = Math.min(end, blockStart + block.byteLength) - position;
            buffer.set(block.subarray(position - blockStart, position - blockStart + count), position - at);
            position += count;
        }
        return end - at;
    }

    // Private

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
        } else {
            block = new Uint8Array(this._reader.readAsArrayBuffer(this._blob.slice(start, Math.min(start + BLOCK_SIZE, this._blob.size))));
            if (cachedBlocks.size >= MAX_CACHED_BLOCKS) {
                cachedBlocks.delete(/** @type {string} */ (cachedBlocks.keys().next().value));
            }
        }
        cachedBlocks.set(key, block);
        return block;
    }
}

/** @type {number} */
let nextHandleId = 0;
/**
 * The blocks `BlobReadHandle` read, by handle and position, from the least recently used.
 * @type {Map<string, Uint8Array>}
 */
const cachedBlocks = new Map();
