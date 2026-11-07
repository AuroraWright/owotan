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
import {BlobFileStore, BlobReadHandle, readBlobs} from '../data/blob-file-store.js';
import {isSafariExtension} from '../extension/app-extension.js';

/**
 * The file in each dictionary's directory that holds what Yomitan knows of it. It is written last,
 * so a directory without it is an import that did not finish.
 */
const RECORD_FILE_NAME = 'yomitan.json';
/**
 * The files hoshidicts may write when it imports a dictionary. The origin private file system only opens
 * files asynchronously and hoshidicts creates them synchronously, so they are opened before it starts.
 */
const IMPORT_FILE_NAMES = ['blobs.bin', 'hash.table', 'bloom.filter', 'scan.idx', 'dict.zstd', 'media.bin', 'media.idx', 'index.json', '.hoshidicts_7'];
/**
 * The files hoshidicts reads only parts of as it looks things up. The others it reads whole when a dictionary is
 * added.
 */
const ON_DEMAND_FILE_NAMES = new Set(['blobs.bin', 'media.bin', 'hash.table']);

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
    async addDictionary(id, hoshidicts, path, write) {
        // hoshidicts writes the files straight into the dictionary's directory, so a large dictionary is never
        // held in memory whole.
        const {fs} = hoshidicts;
        const parent = await this._getDirectory();
        const directory = await parent.getDirectoryHandle(id, {create: true});
        /** @type {{name: string, handle: FileSystemSyncAccessHandle}[]} */
        const files = [];
        let mounted = false;
        try {
            for (const name of IMPORT_FILE_NAMES) {
                files.push({name, handle: await (await directory.getFileHandle(name, {create: true})).createSyncAccessHandle()});
            }
            mountFiles(hoshidicts, path, {files: [], newFiles: files});
            mounted = true;
            const record = await write();
            const written = new Set(findFiles(fs, path).map(({name}) => name));
            unmountFiles(fs, path);
            mounted = false;
            for (const {handle} of files.splice(0)) { handle.close(); }
            for (const name of IMPORT_FILE_NAMES) {
                if (!written.has(name)) { await directory.removeEntry(name); }
            }
            await writeFile(directory, RECORD_FILE_NAME, new TextEncoder().encode(JSON.stringify(record)));
            return record;
        } catch (e) {
            if (mounted) { unmountFiles(fs, path); }
            for (const {handle} of files) { handle.close(); }
            await parent.removeEntry(id, {recursive: true}).catch(() => {});
            throw e;
        }
    }

    /** @type {import('dictionary-database').DictionaryStorage['deleteDictionary']} */
    async deleteDictionary(id) {
        const directory = await this._getDirectory();
        await directory.removeEntry(id, {recursive: true});
    }

    /**
     * Gets the hoshidicts files of a dictionary that is not mounted.
     * @param {string} id
     * @returns {Promise<import('blob-file-store').StoredFile[]>}
     */
    async getFiles(id) {
        const directory = await (await this._getDirectory()).getDirectoryHandle(id);
        /** @type {import('blob-file-store').StoredFile[]} */
        const files = [];
        for await (const handle of getDirectoryEntries(directory)) {
            if (handle.kind !== 'file' || handle.name === RECORD_FILE_NAME) { continue; }
            files.push({name: handle.name, blob: await /** @type {FileSystemFileHandle} */ (handle).getFile()});
        }
        return files;
    }

    /** @type {import('dictionary-database').DictionaryStorage['mount']} */
    async mount(hoshidicts, dictionaries) {
        /** @type {(() => void)[]} */
        const mounts = [];
        for (const {id, path} of dictionaries) {
            try {
                const files = await this._openFiles(id);
                mounts.push(() => {
                    mountFiles(hoshidicts, path, {files});
                    this._mountedHandles.set(path, files.map(({handle}) => handle));
                });
            } catch (e) {
                mounts.push(() => { throw e; });
            }
        }
        return {mounts, release: () => {}};
    }

    /** @type {import('dictionary-database').DictionaryStorage['unmount']} */
    unmount(hoshidicts, path) {
        unmountFiles(hoshidicts.fs, path);
        const handles = this._mountedHandles.get(path);
        if (typeof handles === 'undefined') { return; }
        this._mountedHandles.delete(path);
        for (const handle of handles) { handle.close(); }
    }

    // Private

    /**
     * @param {string} id
     * @returns {Promise<{name: string, handle: FileSystemSyncAccessHandle}[]>}
     */
    async _openFiles(id) {
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
        return files;
    }

    /**
     * @returns {Promise<FileSystemDirectoryHandle>}
     */
    async _getDirectory() {
        const root = await navigator.storage.getDirectory();
        return await root.getDirectoryHandle('dictionaries', {create: true});
    }
}

/**
 * Stores each imported dictionary in IndexedDB, as Blobs of its hoshidicts files, for Safari, where the origin
 * private file system does not keep them (BlobFileStore). hoshidicts imports into the origin private file
 * system, which it writes as it goes, so a large dictionary is never held in memory whole; the files are moved
 * here when it is done. Mounted dictionaries are read through `FileReaderSync`, so only in a worker.
 */
export class BlobDictionaryStorage {
    constructor() {
        /** @type {OpfsDictionaryStorage} */
        this._importStorage = new OpfsDictionaryStorage();
        /** @type {BlobFileStore<import('dictionary-database').DictionaryRecord>} */
        this._store = new BlobFileStore('dictionaries');
    }

    /** @type {import('dictionary-database').DictionaryStorage['getDictionaries']} */
    async getDictionaries() {
        return (await this._store.getAll()).map(({id, record}) => ({id, record}));
    }

    /** @type {import('dictionary-database').DictionaryStorage['addDictionary']} */
    async addDictionary(id, hoshidicts, path, write) {
        const record = await this._importStorage.addDictionary(id, hoshidicts, path, write);
        try {
            await this._store.put({id, files: await this._importStorage.getFiles(id), record});
        } finally {
            await this._importStorage.deleteDictionary(id);
        }
        return record;
    }

    /** @type {import('dictionary-database').DictionaryStorage['deleteDictionary']} */
    async deleteDictionary(id) {
        await this._store.delete(id);
    }

    /**
     * Reads the files hoshidicts reads whole when it adds a dictionary ahead, those of all the dictionaries in one
     * read (`readBlobs`), which takes a small part of the time of the hundreds of reads they would otherwise need.
     * @type {import('dictionary-database').DictionaryStorage['mount']}
     */
    async mount(hoshidicts, dictionaries) {
        const entries = await this._store.getMany(dictionaries.map(({id}) => id));
        const blobs = entries.flatMap((entry) => (entry?.files ?? []).filter(({name}) => !ON_DEMAND_FILE_NAMES.has(name)).map(({blob}) => blob));
        /** @type {Map<Blob, Uint8Array>} */
        const contents = new Map();
        try {
            const results = readBlobs(blobs);
            for (let i = 0; i < blobs.length; ++i) { contents.set(blobs[i], results[i]); }
        } catch (e) {
            // They are read as they are needed.
        }
        const fileLists = entries.map((entry) => entry?.files.map(({name, blob}) => ({name, handle: new BlobReadHandle(blob, contents.get(blob) ?? null)})) ?? null);
        for (const files of fileLists) {
            // hoshidicts reads the header of each hash table as it adds the dictionary, so they are read together.
            files?.find(({name}) => name === 'hash.table')?.handle.advise(0, 4);
        }
        return {
            mounts: dictionaries.map(({id, path}, i) => () => {
                const files = fileLists[i];
                if (files === null) { throw new Error(`No dictionary ${id}`); }
                mountFiles(hoshidicts, path, {files});
            }),
            release: () => {
                contents.clear();
                for (const files of fileLists) {
                    for (const {handle} of files ?? []) { handle.release(); }
                }
            },
        };
    }

    /** @type {import('dictionary-database').DictionaryStorage['unmount']} */
    unmount(hoshidicts, path) {
        unmountFiles(hoshidicts.fs, path);
    }
}

/**
 * Creates the storage for dictionaries in this browser.
 * @returns {import('dictionary-database').DictionaryStorage}
 */
export function createDictionaryStorage() {
    return isSafariExtension() ? new BlobDictionaryStorage() : new OpfsDictionaryStorage();
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
    async addDictionary(id, hoshidicts, path, write) {
        const {fs} = hoshidicts;
        fs.mkdir(path);
        try {
            const record = await write();
            this._dictionaries.set(id, {
                files: findFiles(fs, path).map(({name, path: filePath}) => ({name, content: fs.readFile(filePath)})),
                record: structuredClone(record),
            });
            return record;
        } finally {
            removeDirectory(fs, path);
        }
    }

    /** @type {import('dictionary-database').DictionaryStorage['deleteDictionary']} */
    async deleteDictionary(id) {
        this._dictionaries.delete(id);
    }

    /** @type {import('dictionary-database').DictionaryStorage['mount']} */
    async mount(hoshidicts, dictionaries) {
        return {
            mounts: dictionaries.map(({id, path}) => () => {
                const dictionary = this._dictionaries.get(id);
                if (typeof dictionary === 'undefined') { throw new Error(`No dictionary ${id}`); }
                const {fs} = hoshidicts;
                fs.mkdir(path);
                for (const {name, content} of dictionary.files) {
                    fs.writeFile(`${path}/${name}`, content);
                }
            }),
            release: () => {},
        };
    }

    /** @type {import('dictionary-database').DictionaryStorage['unmount']} */
    unmount(hoshidicts, path) {
        removeDirectory(hoshidicts.fs, path);
    }
}

/**
 * Mounts files at a new directory of the engine's file system, with the file system type of hoshidicts for files
 * of the origin private file system and files read as they are.
 * @param {import('./hoshidicts.js').Hoshidicts} hoshidicts
 * @param {string} path
 * @param {{files: {name: string, handle: unknown}[], newFiles?: {name: string, handle: FileSystemSyncAccessHandle}[]}} options
 */
function mountFiles(hoshidicts, path, options) {
    hoshidicts.fs.mkdir(path);
    hoshidicts.fs.mount(hoshidicts.opfsFileSystem, options, path);
}

/**
 * Unmounts the files `mountFiles` mounted and removes their directory.
 * @param {import('hoshidicts').FileSystem} fs
 * @param {string} path
 */
function unmountFiles(fs, path) {
    fs.unmount(path);
    fs.rmdir(path);
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
 * Finds the files in a directory of the engine's file system and the directories in it. hoshidicts imports
 * into a directory it names after the dictionary.
 * @param {import('hoshidicts').FileSystem} fs
 * @param {string} path
 * @returns {{name: string, path: string}[]}
 */
function findFiles(fs, path) {
    /** @type {{name: string, path: string}[]} */
    const results = [];
    for (const name of fs.readdir(path)) {
        if (name === '.' || name === '..') { continue; }
        const filePath = `${path}/${name}`;
        if (fs.isDir(fs.stat(filePath).mode)) {
            results.push(...findFiles(fs, filePath));
        } else {
            results.push({name, path: filePath});
        }
    }
    return results;
}

/**
 * @param {import('hoshidicts').FileSystem} fs
 * @param {string} path
 */
function removeDirectory(fs, path) {
    for (const name of fs.readdir(path)) {
        if (name === '.' || name === '..') { continue; }
        const filePath = `${path}/${name}`;
        if (fs.isDir(fs.stat(filePath).mode)) {
            removeDirectory(fs, filePath);
        } else {
            fs.unlink(filePath);
        }
    }
    fs.rmdir(path);
}

/**
 * Writes a file of the origin private file system, through a sync access handle, as only those are available
 * where dictionaries are imported.
 * @param {FileSystemDirectoryHandle} directory
 * @param {string} name
 * @param {Uint8Array} content
 */
async function writeFile(directory, name, content) {
    const handle = await (await directory.getFileHandle(name, {create: true})).createSyncAccessHandle();
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
}
