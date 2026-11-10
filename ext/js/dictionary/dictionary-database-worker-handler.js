/*
 * Copyright (C) 2023-2026  Yomitan Authors
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

import {createApiMap, invokeApiMapHandler} from '../core/api-map.js';
import {ExtensionError} from '../core/extension-error.js';
import {log} from '../core/log.js';
import {trimBlockCache} from '../data/blob-file-store.js';
import {DictionaryDatabaseEngine} from './dictionary-database-engine.js';
import {createDictionaryStorage} from './dictionary-storage.js';

/**
 * Hosts the dictionary database's engine. The dictionaries are read through origin private file
 * system sync access handles, or in Safari through `FileReaderSync`, which only a dedicated worker can use.
 */
export class DictionaryDatabaseWorkerHandler {
    constructor() {
        /** @type {DictionaryDatabaseEngine} */
        this._engine = new DictionaryDatabaseEngine(createDictionaryStorage());
        /** @type {Promise<void>} */
        this._preparePromise = Promise.resolve();
        /** @type {import('dictionary-database').ApiMap} */
        this._apiMap = createApiMap([
            ['drawMedia', this._onDrawMedia.bind(this)],
        ]);
    }

    /** */
    prepare() {
        this._preparePromise = this._engine.prepare();
        self.addEventListener('message', this._onMessage.bind(this), false);
        self.addEventListener('messageerror', (event) => {
            const error = new ExtensionError('DictionaryDatabaseWorkerHandler: Error receiving message from main thread');
            error.data = event;
            log.error(error);
        });
    }

    // Private

    /**
     * @param {MessageEvent<import('dictionary-database-worker-handler').MessageToWorker>} event
     */
    _onMessage(event) {
        const message = event.data;
        switch (message.action) {
            case 'invoke':
                void this._invoke(message.params);
                break;
            case 'connectToDatabaseWorker':
                this._connectToDatabaseWorker(event.ports[0]);
                break;
            default:
                log.error(`Unknown action: ${/** @type {{action: unknown}} */ (message).action}`);
        }
    }

    /**
     * @param {import('dictionary-database-worker-handler').InvokeParams} params
     */
    async _invoke({id, name, args}) {
        /** @type {import('dictionary-database-worker-handler').MessageFromWorker} */
        let response;
        try {
            await this._preparePromise;
            const method = /** @type {(...args: unknown[]) => Promise<unknown>} */ (this._engine[name]);
            const result = await method.apply(this._engine, args);
            response = {id, result};
        } catch (e) {
            response = {id, error: ExtensionError.serialize(e)};
        }
        // What the request read ahead past the size of the cache of Blob reads (Safari)
        trimBlockCache();
        self.postMessage(response);
    }

    /**
     * @param {MessagePort} port
     */
    _connectToDatabaseWorker(port) {
        port.onmessage = (/** @type {MessageEvent<import('dictionary-database').ApiMessageAny>} */ event) => {
            const {action, params} = event.data;
            return invokeApiMapHandler(this._apiMap, action, params, [port], () => {});
        };
        port.onmessageerror = (event) => {
            const error = new ExtensionError('DictionaryDatabaseWorkerHandler: Error receiving message from display');
            error.data = event;
            log.error(error);
        };
    }

    /** @type {import('dictionary-database').ApiHandler<'drawMedia'>} */
    _onDrawMedia(params, port) {
        void this._preparePromise.then(() => this._engine.drawMedia(params.requests, port));
    }
}
