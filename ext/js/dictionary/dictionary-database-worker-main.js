/*
 * Copyright (C) 2024-2026  Yomitan Authors
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

import {log} from '../core/log.js';
import {setBlockCache} from '../data/blob-file-store.js';
import {DictionaryDatabaseWorkerHandler} from './dictionary-database-worker-handler.js';
import {setHashTablesInMemory} from './dictionary-storage.js';

/** Entry point. */
function main() {
    try {
        // Given by the page that starts the worker (DictionaryDatabase.blobReadOptions)
        const searchParams = new URLSearchParams(self.location.search);
        const [size, blockSize, readAheadSize] = ['blockCacheSize', 'blockSize', 'readAheadSize'].map((name) => Number.parseInt(searchParams.get(name) ?? '', 10));
        if (Number.isFinite(size) && Number.isFinite(blockSize) && Number.isFinite(readAheadSize)) {
            setBlockCache({size, blockSize, readAheadSize});
        }
        setHashTablesInMemory(searchParams.get('hashTablesInMemory') === 'true');
        const dictionaryDatabaseWorkerHandler = new DictionaryDatabaseWorkerHandler();
        void dictionaryDatabaseWorkerHandler.prepare();
    } catch (e) {
        log.error(e);
    }
}

main();
