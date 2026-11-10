/*
 * Copyright (C) 2023-2026  Yomitan Authors
 * Copyright (C) 2016-2022  Yomichan Authors
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

import {ExtensionError} from '../core/extension-error.js';
import {log} from '../core/log.js';
import {DictionaryDatabaseEngine} from './dictionary-database-engine.js';

/**
 * The dictionary database. Dictionaries are hoshidicts dictionaries; by default they are stored in the
 * origin private file system, or in Safari in IndexedDB (dictionary-storage.js), and read by a dedicated
 * worker, which this class forwards requests to.
 */
export class DictionaryDatabase {
    /**
     * @param {?import('dictionary-database').DictionaryStorage} [storage] A storage to read in this context
     *   instead of using the worker. A context that only imports dictionaries and reads their summaries can
     *   use the storage directly; its dictionaries are never opened here.
     */
    constructor(storage = null) {
        /** @type {?DictionaryDatabaseEngine} */
        this._engine = storage !== null ? new DictionaryDatabaseEngine(storage) : null;
        /** @type {?Worker} */
        this._worker = null;
        /** @type {boolean} */
        this._prepared = false;
        /** @type {number} */
        this._nextRequestId = 0;
        /** @type {Map<number, {resolve: (value: unknown) => void, reject: (reason: Error) => void}>} */
        this._requests = new Map();
        /**
         * How the worker reads dictionaries stored as Blobs (Safari), if not as on phones: how much of them it caches,
         * in blocks of what size, and how much it reads ahead at once, in bytes (`setBlockCache`), and whether it keeps
         * their hash tables in memory. Set before `prepare`.
         * @type {?{blockCacheSize: number, blockSize: number, readAheadSize: number, hashTablesInMemory: boolean}}
         */
        this.blobReadOptions = null;
    }

    /** */
    async prepare() {
        if (this._prepared) {
            throw new Error('Database already open');
        }
        if (this._engine !== null) {
            await this._engine.prepare();
        } else {
            if (this._worker === null) {
                let query = '';
                if (this.blobReadOptions !== null) {
                    const {blockCacheSize, blockSize, readAheadSize, hashTablesInMemory} = this.blobReadOptions;
                    query = `?${new URLSearchParams({
                        blockCacheSize: `${blockCacheSize}`,
                        blockSize: `${blockSize}`,
                        readAheadSize: `${readAheadSize}`,
                        hashTablesInMemory: `${hashTablesInMemory}`,
                    })}`;
                }
                const worker = new Worker(`/js/dictionary/dictionary-database-worker-main.js${query}`, {type: 'module'});
                worker.addEventListener('message', this._onWorkerMessage.bind(this));
                worker.addEventListener('error', (event) => {
                    log.log('Worker terminated with error:', event);
                });
                this._worker = worker;
            }
            // The worker prepares its engine as it starts; this waits for that.
            await this._call('reload');
        }
        this._prepared = true;
    }

    /** */
    async close() {
        this._prepared = false;
        if (this._engine !== null) {
            await this._engine.close();
        }
        if (this._worker !== null) {
            this._worker.terminate();
            this._worker = null;
            for (const {reject} of this._requests.values()) {
                reject(new Error('Database closed'));
            }
            this._requests.clear();
        }
    }

    /**
     * @returns {boolean}
     */
    isPrepared() {
        return this._prepared;
    }

    /**
     * Reads the stored dictionaries again, after another context imported or deleted one.
     */
    async reload() {
        await this._call('reload');
    }

    /**
     * @returns {Promise<boolean>}
     */
    async purge() {
        return await this._call('purge');
    }

    /**
     * @param {string} dictionaryName
     */
    async deleteDictionary(dictionaryName) {
        await this._call('deleteDictionary', dictionaryName);
    }

    /**
     * Stores a dictionary hoshidicts imports. Only a database that has its storage in this context can, as
     * `write` cannot be sent to the worker.
     * @param {import('./hoshidicts.js').Hoshidicts} hoshidicts
     * @param {string} path
     * @param {() => Promise<import('dictionary-database').DictionaryRecord>} write
     * @returns {Promise<import('dictionary-database').DictionaryRecord>} The record `write` returned.
     */
    async addDictionary(hoshidicts, path, write) {
        if (this._engine === null) {
            throw new Error('Dictionaries can only be added with a storage in this context');
        }
        return await this._engine.addDictionary(hoshidicts, path, write);
    }

    /**
     * @param {string[]} termList
     * @param {import('dictionary-database').DictionarySet} dictionaries
     * @returns {Promise<import('dictionary-database').TermEntry[]>}
     */
    findTermsBulk(termList, dictionaries) {
        return this._call('findTermsBulk', termList, [...dictionaries.keys()]);
    }

    /**
     * @param {import('dictionary-database').TermExactRequest[]} termList
     * @param {import('dictionary-database').DictionarySet} dictionaries
     * @returns {Promise<import('dictionary-database').TermEntry[]>}
     */
    findTermsExactBulk(termList, dictionaries) {
        return this._call('findTermsExactBulk', termList, [...dictionaries.keys()]);
    }

    /**
     * @param {import('dictionary-database').DictionaryAndQueryRequest[]} items
     * @returns {Promise<import('dictionary-database').TermEntry[]>}
     */
    findTermsBySequenceBulk(items) {
        return this._call('findTermsBySequenceBulk', items);
    }

    /**
     * @param {string[]} termList
     * @param {import('dictionary-database').DictionarySet} dictionaries
     * @returns {Promise<import('dictionary-database').TermMeta[]>}
     */
    findTermMetaBulk(termList, dictionaries) {
        return this._call('findTermMetaBulk', termList, [...dictionaries.keys()]);
    }

    /**
     * @param {string[]} kanjiList
     * @param {import('dictionary-database').DictionarySet} dictionaries
     * @returns {Promise<import('dictionary-database').KanjiEntry[]>}
     */
    findKanjiBulk(kanjiList, dictionaries) {
        return this._call('findKanjiBulk', kanjiList, [...dictionaries.keys()]);
    }

    /**
     * @param {string[]} kanjiList
     * @param {import('dictionary-database').DictionarySet} dictionaries
     * @returns {Promise<import('dictionary-database').KanjiMeta[]>}
     */
    findKanjiMetaBulk(kanjiList, dictionaries) {
        return this._call('findKanjiMetaBulk', kanjiList, [...dictionaries.keys()]);
    }

    /**
     * Loads the glossaries of term rows by id, for rows whose definitions were deferred.
     * @param {import('dictionary-database').TermGlossaryRequest[]} items
     * @returns {Promise<import('dictionary-data').TermGlossary[][]>}
     */
    findTermGlossariesBulk(items) {
        return this._call('findTermGlossariesBulk', items);
    }

    /**
     * @param {import('dictionary-database').DictionaryAndQueryRequest[]} items
     * @returns {Promise<(import('dictionary-database').Tag|undefined)[]>}
     */
    findTagMetaBulk(items) {
        return this._call('findTagMetaBulk', items);
    }

    /**
     * @param {import('dictionary-database').MediaRequest[]} items
     * @returns {Promise<import('dictionary-database').Media[]>}
     */
    getMedia(items) {
        return this._call('getMedia', items);
    }

    /**
     * @returns {Promise<import('dictionary-importer').Summary[]>}
     */
    getDictionaryInfo() {
        return this._call('getDictionaryInfo');
    }

    /**
     * @param {string[]} dictionaryNames
     * @param {boolean} getTotal
     * @returns {Promise<import('dictionary-database').DictionaryCounts>}
     */
    getDictionaryCounts(dictionaryNames, getTotal) {
        return this._call('getDictionaryCounts', dictionaryNames, getTotal);
    }

    /**
     * @param {string} title
     * @returns {Promise<boolean>}
     */
    dictionaryExists(title) {
        return this._call('dictionaryExists', title);
    }

    /**
     * Connects a display's media drawing port to the worker, which draws the images it asks for.
     * @param {MessagePort} port
     */
    async connectToDatabaseWorker(port) {
        if (this._worker === null) {
            throw new Error('Database has no worker');
        }
        this._worker.postMessage({action: 'connectToDatabaseWorker', params: null}, [port]);
    }

    // Private

    /**
     * @template {import('dictionary-database-worker-handler').EngineMethodName} TName
     * @param {TName} name
     * @param {Parameters<DictionaryDatabaseEngine[TName]>} args
     * @returns {Promise<Awaited<ReturnType<DictionaryDatabaseEngine[TName]>>>}
     */
    _call(name, ...args) {
        if (this._engine !== null) {
            const method = /** @type {(...args: unknown[]) => Promise<Awaited<ReturnType<DictionaryDatabaseEngine[TName]>>>} */ (this._engine[name]);
            return method.apply(this._engine, args);
        }
        if (this._worker === null) {
            return Promise.reject(new Error('Database not open'));
        }
        const id = this._nextRequestId++;
        /** @type {import('dictionary-database-worker-handler').MessageToWorker} */
        const message = {action: 'invoke', params: {id, name, args}};
        return new Promise((resolve, reject) => {
            this._requests.set(id, {
                resolve: (value) => resolve(/** @type {Awaited<ReturnType<DictionaryDatabaseEngine[TName]>>} */ (value)),
                reject,
            });
            /** @type {Worker} */ (this._worker).postMessage(message);
        });
    }

    /**
     * @param {MessageEvent<import('dictionary-database-worker-handler').MessageFromWorker>} event
     */
    _onWorkerMessage(event) {
        const response = event.data;
        const request = this._requests.get(response.id);
        if (typeof request === 'undefined') { return; }
        this._requests.delete(response.id);
        if ('error' in response) {
            request.reject(ExtensionError.deserialize(response.error));
        } else {
            request.resolve(response.result);
        }
    }
}
