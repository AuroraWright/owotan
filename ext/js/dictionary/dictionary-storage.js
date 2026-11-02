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

import {parseJson} from '../core/json.js';

/**
 * The file in each dictionary's directory that holds what Yomitan knows of it. It is written last,
 * so a directory without it is an import that did not finish.
 */
const RECORD_FILE_NAME = 'yomitan.json';

/**
 * Stores each imported dictionary as a directory of hoshidicts files in the origin private file system.
 * Mounted dictionaries are read through sync access handles, which lock their files, so they can only be
 * mounted in a dedicated worker, and only the context that mounted a dictionary can delete it.
 */
export class OpfsDictionaryStorage {
    constructor() {
        /** @type {Map<string, FileSystemSyncAccessHandle[]>} */
        this._mountedHandles = new Map();
    }

    /** @type {import('dictionary-database').DictionaryStorage['getDictionaries']} */
    async getDictionaries() {
        const directory = await this._getDirectory();
        /** @type {import('dictionary-database').StoredDictionary[]} */
        const results = [];
        for await (const handle of getDirectoryEntries(directory)) {
            if (handle.kind !== 'directory') { continue; }
            let file;
            try {
                file = await (await /** @type {FileSystemDirectoryHandle} */ (handle).getFileHandle(RECORD_FILE_NAME)).getFile();
            } catch (e) {
                continue;
            }
            const record = parseJson(await file.text());
            results.push({id: handle.name, record: /** @type {import('dictionary-database').DictionaryRecord} */ (record)});
        }
        return results;
    }

    /** @type {import('dictionary-database').DictionaryStorage['addDictionary']} */
    async addDictionary(id, files, record) {
        const parent = await this._getDirectory();
        const directory = await parent.getDirectoryHandle(id, {create: true});
        try {
            for (const {name, content} of files) {
                await writeFile(directory, name, content);
            }
            await writeFile(directory, RECORD_FILE_NAME, new TextEncoder().encode(JSON.stringify(record)));
        } catch (e) {
            await parent.removeEntry(id, {recursive: true}).catch(() => {});
            throw e;
        }
    }

    /** @type {import('dictionary-database').DictionaryStorage['deleteDictionary']} */
    async deleteDictionary(id) {
        const directory = await this._getDirectory();
        await directory.removeEntry(id, {recursive: true});
    }

    /** @type {import('dictionary-database').DictionaryStorage['mount']} */
    async mount(hoshidicts, id, path) {
        const directory = await (await this._getDirectory()).getDirectoryHandle(id);
        /** @type {{name: string, handle: FileSystemSyncAccessHandle}[]} */
        const files = [];
        try {
            for await (const handle of getDirectoryEntries(directory)) {
                if (handle.kind !== 'file' || handle.name === RECORD_FILE_NAME) { continue; }
                files.push({name: handle.name, handle: await /** @type {FileSystemFileHandle} */ (handle).createSyncAccessHandle()});
            }
        } catch (e) {
            for (const {handle} of files) { handle.close(); }
            throw e;
        }
        return () => {
            const {fs} = hoshidicts;
            fs.mkdir(path);
            fs.mount(hoshidicts.opfsFileSystem, {files}, path);
            this._mountedHandles.set(path, files.map(({handle}) => handle));
        };
    }

    /** @type {import('dictionary-database').DictionaryStorage['unmount']} */
    unmount(hoshidicts, path) {
        const {fs} = hoshidicts;
        fs.unmount(path);
        fs.rmdir(path);
        const handles = this._mountedHandles.get(path);
        if (typeof handles === 'undefined') { return; }
        this._mountedHandles.delete(path);
        for (const handle of handles) { handle.close(); }
    }

    // Private

    /**
     * @returns {Promise<FileSystemDirectoryHandle>}
     */
    async _getDirectory() {
        const root = await navigator.storage.getDirectory();
        return await root.getDirectoryHandle('dictionaries', {create: true});
    }
}

/**
 * Keeps dictionaries in memory, for tests.
 */
export class MemoryDictionaryStorage {
    constructor() {
        /** @type {Map<string, {files: import('dictionary-database').DictionaryFile[], record: import('dictionary-database').DictionaryRecord}>} */
        this._dictionaries = new Map();
    }

    /** @type {import('dictionary-database').DictionaryStorage['getDictionaries']} */
    async getDictionaries() {
        return [...this._dictionaries].map(([id, {record}]) => ({id, record: structuredClone(record)}));
    }

    /** @type {import('dictionary-database').DictionaryStorage['addDictionary']} */
    async addDictionary(id, files, record) {
        this._dictionaries.set(id, {
            files: files.map(({name, content}) => ({name, content: new Uint8Array(content)})),
            record: structuredClone(record),
        });
    }

    /** @type {import('dictionary-database').DictionaryStorage['deleteDictionary']} */
    async deleteDictionary(id) {
        this._dictionaries.delete(id);
    }

    /** @type {import('dictionary-database').DictionaryStorage['mount']} */
    async mount(hoshidicts, id, path) {
        const dictionary = this._dictionaries.get(id);
        if (typeof dictionary === 'undefined') { throw new Error(`No dictionary ${id}`); }
        return () => {
            const {fs} = hoshidicts;
            fs.mkdir(path);
            for (const {name, content} of dictionary.files) {
                fs.writeFile(`${path}/${name}`, content);
            }
        };
    }

    /** @type {import('dictionary-database').DictionaryStorage['unmount']} */
    unmount(hoshidicts, path) {
        const {fs} = hoshidicts;
        for (const name of fs.readdir(path)) {
            if (name === '.' || name === '..') { continue; }
            fs.unlink(`${path}/${name}`);
        }
        fs.rmdir(path);
    }
}

/**
 * @param {FileSystemDirectoryHandle} directory
 * @returns {AsyncIterable<FileSystemHandle>}
 */
function getDirectoryEntries(directory) {
    // The async iteration methods are missing from the DOM types in use.
    return /** @type {{values: () => AsyncIterable<FileSystemHandle>}} */ (/** @type {unknown} */ (directory)).values();
}

/**
 * @param {FileSystemDirectoryHandle} directory
 * @param {string} name
 * @param {Uint8Array} content
 */
async function writeFile(directory, name, content) {
    const fileHandle = await directory.getFileHandle(name, {create: true});
    if (typeof fileHandle.createSyncAccessHandle === 'function' && typeof WorkerGlobalScope !== 'undefined') {
        const handle = await fileHandle.createSyncAccessHandle();
        try {
            handle.truncate(0);
            let written = 0;
            while (written < content.byteLength) {
                written += handle.write(content.subarray(written), {at: written});
            }
            handle.flush();
        } finally {
            handle.close();
        }
    } else {
        const writable = await fileHandle.createWritable();
        await writable.write(content);
        await writable.close();
    }
}
