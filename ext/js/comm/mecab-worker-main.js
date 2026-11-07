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

import {
    Uint8ArrayReader as Uint8ArrayReader0,
    Uint8ArrayWriter as Uint8ArrayWriter0,
    ZipReader as ZipReader0,
    configure,
} from '../../lib/zip.js';
import {toError} from '../core/to-error.js';
import {BlobFileStore, BlobReadHandle} from '../data/blob-file-store.js';

const Uint8ArrayReader = /** @type {typeof import('@zip.js/zip.js').Uint8ArrayReader} */ (/** @type {unknown} */ (Uint8ArrayReader0));
const Uint8ArrayWriter = /** @type {typeof import('@zip.js/zip.js').Uint8ArrayWriter} */ (/** @type {unknown} */ (Uint8ArrayWriter0));
const ZipReader = /** @type {typeof import('@zip.js/zip.js').ZipReader} */ (/** @type {unknown} */ (ZipReader0));

/**
 * The fields of each dictionary's features, in order, as the native MeCab component names them
 * (yomitan-mecab-installer's mecab.py). A dictionary is known by the name of its directory.
 * @type {Map<string, string[]>}
 */
const DICTIONARY_FIELDS = new Map([
    ['ipadic', ['pos1', 'pos2', 'pos3', 'pos4', 'inflection_type', 'inflection_form', 'expression', 'reading', 'pron']],
    ['ipadic-neologd', ['pos1', 'pos2', 'pos3', 'pos4', '_', '_', 'expression', 'reading', 'pron']],
    ['unidic-mecab-translate', ['pos1', 'pos2', 'pos3', 'pos4', 'inflection_type', 'inflection_form', 'lemma_reading', 'lemma', 'expression', 'reading', 'expression_base', 'reading_base']],
    ['unidic-csj-202302', ['pos1', 'pos2', 'pos3', 'pos4', 'inflection_type', 'inflection_form', 'lemma_reading', 'lemma', 'expression', 'reading', 'expression_base', 'reading_base']],
]);
/** The channel on which a worker that changes the dictionaries tells the others to load them again. */
const CHANGE_CHANNEL_NAME = 'yomitan-mecab-dictionaries';
/** Characters that are not given to MeCab, but kept as tokens of their own. */
const SKIP_PATTERN = /[\s・]/u;
/** The line breaks at which Python's `str.splitlines` splits, which include the file, group and record separators. */
// eslint-disable-next-line no-control-regex
const LINE_BREAK_PATTERN = /\r\n|[\n\v\f\r\u001c-\u001e\u0085\u2028\u2029]/u;

/**
 * Runs MeCab, compiled to WebAssembly (dev/mecab). It answers the messages that the native MeCab component answered,
 * with the same results, and also imports and removes the dictionaries, which are kept in IndexedDB (BlobFileStore),
 * by their names. Requests come from the worker's creator, or from a port that it passes with a `connect` message, as
 * Chrome's offscreen document does for the service worker.
 */
class MecabWorker {
    constructor() {
        /** @type {?Promise<import('mecab-worker').Module>} */
        this._modulePromise = null;
        /** @type {?Promise<Map<string, import('mecab-worker').Tagger>>} */
        this._taggersPromise = null;
        /** @type {BroadcastChannel} */
        this._changeChannel = new BroadcastChannel(CHANGE_CHANNEL_NAME);
        /** @type {BlobFileStore} */
        this._store = new BlobFileStore('mecab-dictionaries');
    }

    /** */
    prepare() {
        self.addEventListener('message', this._onMessage.bind(this));
        this._changeChannel.addEventListener('message', this._onDictionariesChanged.bind(this));
        configure({useWebWorkers: false});
    }

    // Private

    /**
     * @param {MessageEvent<import('mecab-worker').Request|import('mecab-worker').ConnectMessage>} event
     */
    _onMessage({data, ports}) {
        if (data.action === 'connect') {
            const port = ports[0];
            port.addEventListener('message', (/** @type {MessageEvent<import('mecab-worker').Request>} */ event) => { void this._onRequest(event.data, port); });
            port.start();
            return;
        }
        void this._onRequest(/** @type {import('mecab-worker').Request} */ (data), self);
    }

    /**
     * @param {import('mecab-worker').Request} request
     * @param {{postMessage: (message: import('mecab-worker').Response) => void}} target
     */
    async _onRequest({action, params, sequence}, target) {
        /** @type {import('mecab-worker').Response} */
        let response;
        try {
            response = {sequence, data: await this._invoke(action, params)};
        } catch (e) {
            response = {sequence, error: toError(e).message};
        }
        target.postMessage(response);
    }

    /**
     * @param {string} action
     * @param {import('mecab-worker').RequestParams} params
     * @returns {Promise<unknown>}
     * @throws {Error}
     */
    async _invoke(action, params) {
        switch (action) {
            case 'parse_text':
                return await this._parseText(params.text ?? '', params.dictionaries);
            case 'get_dictionaries':
                return [...(await this._getTaggers()).keys()];
            case 'import_dictionary':
                if (typeof params.archive === 'undefined') { throw new Error('Missing archive'); }
                return await this._importDictionary(params.archive);
            case 'delete_dictionary':
                if (typeof params.name !== 'string') { throw new Error('Missing dictionary name'); }
                await this._deleteDictionary(params.name);
                return null;
            default:
                throw new Error(`Unsupported action: ${action}`);
        }
    }

    /** */
    _onDictionariesChanged() {
        void this._unloadTaggers();
    }

    /**
     * @param {string} text
     * @param {string[]|undefined} dictionaries
     * @returns {Promise<import('mecab').ParseResultRaw>}
     */
    async _parseText(text, dictionaries) {
        const taggers = await this._getTaggers();
        /** @type {import('mecab').ParseResultRaw} */
        const results = {};
        for (const [name, tagger] of taggers) {
            if (Array.isArray(dictionaries) && dictionaries.length > 0 && !dictionaries.includes(name)) { continue; }
            results[name] = splitLines(text).map((line) => this._parseLine(tagger, line));
        }
        return results;
    }

    /**
     * @param {import('mecab-worker').Tagger} tagger
     * @param {string} line
     * @returns {import('mecab').ParseResultLineRaw}
     */
    _parseLine({fields, parse}, line) {
        /** @type {import('mecab').ParseResultLineRaw} */
        const results = [];
        // Text between the characters that are skipped is parsed on its own, as the native component does.
        let start = 0;
        for (let i = 0; i <= line.length; ++i) {
            if (i < line.length && !SKIP_PATTERN.test(line[i])) { continue; }
            if (i > start) {
                for (const output of parse(line.substring(start, i)).split('\n')) {
                    if (output === 'EOS' || output.length === 0) { continue; }
                    const tab = output.indexOf('\t');
                    if (tab < 0) { continue; }
                    const values = output.substring(tab + 1).split(',');
                    results.push(this._createToken(fields, output.substring(0, tab), values));
                }
            }
            if (i < line.length) {
                results.push(this._createToken(fields, line[i], []));
            }
            start = i + 1;
        }
        return results;
    }

    /**
     * @param {string[]} fields
     * @param {string} source
     * @param {string[]} values
     * @returns {import('mecab').ParseResultTermRaw}
     */
    _createToken(fields, source, values) {
        /** @type {{[key: string]: ?string}} */
        const token = {source};
        for (let i = 0; i < fields.length; ++i) {
            const value = values[i];
            token[fields[i]] = typeof value === 'undefined' || value === '*' ? null : value.replace(new RegExp(SKIP_PATTERN, 'gu'), '|');
        }
        return /** @type {import('mecab').ParseResultTermRaw} */ (token);
    }

    /**
     * @returns {Promise<Map<string, import('mecab-worker').Tagger>>}
     */
    _getTaggers() {
        if (this._taggersPromise === null) {
            this._taggersPromise = this._loadTaggers();
            this._taggersPromise.catch(() => { this._taggersPromise = null; });
        }
        return this._taggersPromise;
    }

    /** */
    async _unloadTaggers() {
        const taggersPromise = this._taggersPromise;
        this._taggersPromise = null;
        if (taggersPromise === null) { return; }
        try {
            for (const tagger of (await taggersPromise).values()) {
                tagger.destroy();
            }
        } catch (e) {
            // NOP
        }
    }

    /**
     * Has MeCab read each dictionary. It reads the files whole when a tagger is made, so they are unmounted again at once.
     * @returns {Promise<Map<string, import('mecab-worker').Tagger>>}
     */
    async _loadTaggers() {
        const module = await this._getModule();
        const {FS, OPFSFS, cwrap} = module;
        /** @type {(argument: string) => number} */
        const createTagger = cwrap('mecab_new2', 'number', ['string']);
        /** @type {(tagger: number, text: string) => string} */
        const parse = cwrap('mecab_sparse_tostr', 'string', ['number', 'string']);
        /** @type {(tagger: number) => string} */
        const getError = cwrap('mecab_strerror', 'string', ['number']);
        /** @type {(tagger: number) => void} */
        const destroyTagger = cwrap('mecab_destroy', null, ['number']);

        /** @type {Map<string, import('mecab-worker').Tagger>} */
        const taggers = new Map();
        for (const {id: name, files} of await this._store.getAll()) {
            const fields = DICTIONARY_FIELDS.get(name);
            if (typeof fields === 'undefined') { continue; }
            const path = `/dictionaries/${name}`;
            FS.mkdirTree(path);
            FS.mount(OPFSFS, {files: files.map(({name: fileName, blob}) => ({name: fileName, handle: new BlobReadHandle(blob)}))}, path);
            try {
                const tagger = createTagger(`-d ${path} -r /mecabrc`);
                if (tagger === 0) {
                    throw new Error(`MeCab could not load ${name}: ${getError(0)}`);
                }
                taggers.set(name, {
                    fields,
                    parse: (text) => parse(tagger, text),
                    destroy: () => destroyTagger(tagger),
                });
            } finally {
                FS.unmount(path);
            }
        }
        return taggers;
    }

    /**
     * @returns {Promise<import('mecab-worker').Module>}
     */
    _getModule() {
        if (this._modulePromise === null) {
            this._modulePromise = this._createModule();
        }
        return this._modulePromise;
    }

    /**
     * @returns {Promise<import('mecab-worker').Module>}
     */
    async _createModule() {
        // The module is generated by `npm run build:mecab`; a variable specifier keeps it out of type checking.
        const moduleUrl = new URL('../../lib/mecab.js', import.meta.url).href;
        // eslint-disable-next-line no-unsanitized/method
        const modulePromise = /** @type {Promise<{default: import('mecab-worker').CreateModule}>} */ (import(moduleUrl));
        const {default: createModule} = await modulePromise;
        const module = await createModule();
        // MeCab needs a resource file, which may be empty, when it is not given a dictionary's own.
        module.FS.writeFile('/mecabrc', new Uint8Array(0));
        return module;
    }

    /**
     * Stores a dictionary from an archive like those the native MeCab component's installer downloads, with one
     * directory, named after the dictionary, that holds MeCab's compiled dictionary files.
     * @param {ArrayBuffer} archive
     * @returns {Promise<string>} The dictionary's name.
     * @throws {Error}
     */
    async _importDictionary(archive) {
        const zipReader = new ZipReader(new Uint8ArrayReader(new Uint8Array(archive)));
        try {
            const entries = (await zipReader.getEntries()).filter(({directory}) => !directory);
            const names = new Set(entries.map(({filename}) => filename.split('/')[0]));
            const [name] = names;
            if (names.size !== 1 || typeof name === 'undefined' || !DICTIONARY_FIELDS.has(name) || !entries.some(({filename}) => filename === `${name}/sys.dic`)) {
                throw new Error(`The archive must hold one MeCab dictionary in a directory named ${[...DICTIONARY_FIELDS.keys()].join(', ')}`);
            }

            /** @type {import('blob-file-store').StoredFile[]} */
            const files = [];
            for (const entry of entries) {
                const fileName = entry.filename.substring(name.length + 1);
                if (fileName.includes('/') || typeof entry.getData === 'undefined') { continue; }
                files.push({name: fileName, blob: new Blob([await entry.getData(new Uint8ArrayWriter())])});
            }
            await this._store.put({id: name, files, record: null});
            this._notifyDictionariesChanged();
            return name;
        } finally {
            await zipReader.close();
        }
    }

    /**
     * @param {string} name
     */
    async _deleteDictionary(name) {
        await this._store.delete(name);
        this._notifyDictionariesChanged();
    }

    /** */
    _notifyDictionariesChanged() {
        void this._unloadTaggers();
        this._changeChannel.postMessage(null);
    }
}

/**
 * Splits text into lines as Python's `str.splitlines` does, which drops a break that ends the text.
 * @param {string} text
 * @returns {string[]}
 */
function splitLines(text) {
    const lines = text.split(LINE_BREAK_PATTERN);
    if (lines[lines.length - 1] === '') { lines.pop(); }
    return lines;
}

new MecabWorker().prepare();
