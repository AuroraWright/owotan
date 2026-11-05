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

import {initWasm, Resvg} from '../../lib/resvg-wasm.js';
import {parseJson} from '../core/json.js';
import {log} from '../core/log.js';
import {safePerformance} from '../core/safe-performance.js';
import {generateId} from '../core/utilities.js';
import {getImageMediaTypeFromFileName} from '../media/media-util.js';
import {Hoshidicts, isCrossOriginIsolated} from './hoshidicts.js';

/**
 * A term row's id is its dictionary's position in import order times this, plus the row's offset in
 * the dictionary's files, so ids sort as the rows were imported.
 */
const ID_SCALE = 2 ** 40;

const MOUNT_DIRECTORY = '/dictionaries';

/**
 * Answers the dictionary database's requests from hoshidicts dictionaries kept in a `DictionaryStorage`.
 * Dictionaries are mounted on the first query, so a context that only imports never opens them.
 */
export class DictionaryDatabaseEngine {
    /**
     * @param {import('dictionary-database').DictionaryStorage} storage
     */
    constructor(storage) {
        /** @type {import('dictionary-database').DictionaryStorage} */
        this._storage = storage;
        /** @type {?Hoshidicts} */
        this._hoshidicts = null;
        /** @type {import('dictionary-database').EngineDictionary[]} */
        this._dictionaries = [];
        /** @type {Map<string, import('dictionary-database').EngineDictionary>} */
        this._dictionaryMap = new Map();
        /** @type {Map<string, string>} Mount paths by dictionary id. */
        this._mounted = new Map();
        /** @type {boolean} */
        this._prepared = false;
        /** @type {boolean} */
        this._mountStale = true;
        /** @type {Promise<void>} Serializes changes to the dictionary set. */
        this._queue = Promise.resolve();
        /** @type {?Promise<Uint8Array>} */
        this._resvgPromise = null;
    }

    /** */
    async prepare() {
        await this._enqueue(() => this._readDictionaries());
        this._prepared = true;
    }

    /** */
    async close() {
        await this._enqueue(async () => {
            this._unmountAll();
            this._prepared = false;
        });
    }

    /**
     * @returns {boolean}
     */
    isPrepared() {
        return this._prepared;
    }

    /**
     * Reads the stored dictionaries again, for changes another context made.
     */
    async reload() {
        this._ensureOpen();
        await this._enqueue(() => this._readDictionaries());
    }

    /**
     * @returns {Promise<boolean>}
     */
    async purge() {
        this._ensureOpen();
        let result = true;
        await this._enqueue(async () => {
            this._unmountAll();
            for (const {id} of await this._storage.getDictionaries()) {
                try {
                    await this._storage.deleteDictionary(id);
                } catch (e) {
                    log.error(e);
                    result = false;
                }
            }
            await this._readDictionaries();
        });
        return result;
    }

    /**
     * @param {string} dictionaryName
     */
    async deleteDictionary(dictionaryName) {
        this._ensureOpen();
        await this._enqueue(async () => {
            for (const {id, record} of await this._storage.getDictionaries()) {
                if (record.summary.title !== dictionaryName) { continue; }
                this._unmount(id);
                await this._storage.deleteDictionary(id);
            }
            await this._readDictionaries();
        });
    }

    /**
     * Stores a dictionary hoshidicts imports.
     * @param {import('./hoshidicts.js').Hoshidicts} hoshidicts The engine that imports it, which is not this one's.
     * @param {string} path Where `write` has hoshidicts import it.
     * @param {() => Promise<import('dictionary-database').DictionaryRecord>} write
     * @returns {Promise<import('dictionary-database').DictionaryRecord>} The record `write` returned.
     */
    async addDictionary(hoshidicts, path, write) {
        this._ensureOpen();
        return await this._enqueue(async () => {
            const record = await this._storage.addDictionary(`${Date.now().toString(36)}-${generateId(4)}`, hoshidicts, path, write);
            await this._readDictionaries();
            return record;
        });
    }

    /**
     * @param {string[]} termList
     * @param {string[]} dictionaryNames
     * @param {import('dictionary-database').MatchType} matchType
     * @returns {Promise<import('dictionary-database').TermEntry[]>}
     */
    async findTermsBulk(termList, dictionaryNames, matchType) {
        // Only exact matches can be found in a hash index, so wildcard searches find exact matches.
        void matchType;
        const hoshidicts = await this._getHoshidicts();
        const enabled = new Set(dictionaryNames);
        const rowLists = hoshidicts.findTerms(termList);
        /** @type {Set<number>} */
        const visited = new Set();
        /** @type {import('dictionary-database').TermEntry[]} */
        const results = [];
        for (let i = 0, ii = rowLists.length; i < ii; ++i) {
            /** @type {{id: number, row: import('hoshidicts').TermRow}[]} */
            const termRows = [];
            /** @type {{id: number, row: import('hoshidicts').TermRow}[]} */
            const readingRows = [];
            for (const row of rowLists[i]) {
                if (!enabled.has(row.dict_name)) { continue; }
                const id = this._getTermId(row);
                if (id === null) { continue; }
                (row.reading_match ? readingRows : termRows).push({id, row});
            }
            // As an index of expressions followed by one of readings would find them.
            for (const rows of [termRows, readingRows]) {
                rows.sort((a, b) => a.id - b.id);
                for (const {id, row} of rows) {
                    if (visited.has(id)) { continue; }
                    visited.add(id);
                    results.push(this._createTerm(row, id, row.reading_match ? 'reading' : 'term', i));
                }
            }
        }
        return results;
    }

    /**
     * @param {import('dictionary-database').TermExactRequest[]} termList
     * @param {string[]} dictionaryNames
     * @returns {Promise<import('dictionary-database').TermEntry[]>}
     */
    async findTermsExactBulk(termList, dictionaryNames) {
        const hoshidicts = await this._getHoshidicts();
        const enabled = new Set(dictionaryNames);
        const rowLists = hoshidicts.findTerms(termList.map(({term}) => term));
        /** @type {import('dictionary-database').TermEntry[]} */
        const results = [];
        for (let i = 0, ii = rowLists.length; i < ii; ++i) {
            const {term, reading} = termList[i];
            const rows = [];
            for (const row of rowLists[i]) {
                if (row.expression !== term || row.reading !== reading || !enabled.has(row.dict_name)) { continue; }
                const id = this._getTermId(row);
                if (id !== null) { rows.push({id, row}); }
            }
            rows.sort((a, b) => a.id - b.id);
            for (const {id, row} of rows) {
                results.push(this._createTerm(row, id, 'term', i));
            }
        }
        return results;
    }

    /**
     * @param {import('dictionary-database').DictionaryAndQueryRequest[]} items
     * @returns {Promise<import('dictionary-database').TermEntry[]>}
     */
    async findTermsBySequenceBulk(items) {
        const hoshidicts = await this._getHoshidicts();
        const rowLists = hoshidicts.findTermsBySequence(items.map(({query, dictionary}) => [dictionary, Number(query)]));
        /** @type {import('dictionary-database').TermEntry[]} */
        const results = [];
        for (let i = 0, ii = rowLists.length; i < ii; ++i) {
            const rows = [];
            for (const row of rowLists[i]) {
                const id = this._getTermId(row);
                if (id !== null) { rows.push({id, row}); }
            }
            rows.sort((a, b) => a.id - b.id);
            for (const {id, row} of rows) {
                results.push(this._createTerm(row, id, 'sequence', i));
            }
        }
        return results;
    }

    /**
     * Loads the glossaries of term rows by id, for rows whose definitions were deferred.
     * @param {import('dictionary-database').TermGlossaryRequest[]} items
     * @returns {Promise<import('dictionary-data').TermGlossary[][]>}
     */
    async findTermGlossariesBulk(items) {
        const hoshidicts = await this._getHoshidicts();
        const glossaries = hoshidicts.getGlossaries(items.map(({id, dictionary}) => [dictionary, id % ID_SCALE]));
        return glossaries.map((glossary, i) => {
            const dictionary = this._dictionaryMap.get(items[i].dictionary);
            if (glossary === null || typeof dictionary === 'undefined') { return []; }
            return this._normalizeGlossary(glossary, dictionary.media);
        });
    }

    /**
     * @param {string[]} termList
     * @param {string[]} dictionaryNames
     * @returns {Promise<import('dictionary-database').TermMeta[]>}
     */
    async findTermMetaBulk(termList, dictionaryNames) {
        const hoshidicts = await this._getHoshidicts();
        const enabled = new Set(dictionaryNames);
        const rowLists = hoshidicts.findTermMeta(termList);
        /** @type {import('dictionary-database').TermMeta[]} */
        const results = [];
        for (let index = 0, ii = rowLists.length; index < ii; ++index) {
            for (const {dict_name: dictionary, expression: term, mode, data} of rowLists[index]) {
                if (!enabled.has(dictionary)) { continue; }
                switch (mode) {
                    case 'freq':
                    case 'pitch':
                    case 'ipa':
                        results.push(/** @type {import('dictionary-database').TermMeta} */ ({index, term, mode, data: parseJson(data), dictionary}));
                        break;
                }
            }
        }
        return results;
    }

    /**
     * @param {string[]} kanjiList
     * @param {string[]} dictionaryNames
     * @returns {Promise<import('dictionary-database').KanjiEntry[]>}
     */
    async findKanjiBulk(kanjiList, dictionaryNames) {
        const hoshidicts = await this._getHoshidicts();
        const enabled = new Set(dictionaryNames);
        const rowLists = hoshidicts.findKanji(kanjiList);
        /** @type {import('dictionary-database').KanjiEntry[]} */
        const results = [];
        for (let index = 0, ii = rowLists.length; index < ii; ++index) {
            for (const row of rowLists[index]) {
                if (!enabled.has(row.dict_name)) { continue; }
                results.push({
                    index,
                    character: row.character,
                    onyomi: splitField(row.onyomi),
                    kunyomi: splitField(row.kunyomi),
                    tags: splitField(row.tags),
                    definitions: row.meanings,
                    stats: row.stats,
                    dictionary: row.dict_name,
                });
            }
        }
        return results;
    }

    /**
     * @param {string[]} kanjiList
     * @param {string[]} dictionaryNames
     * @returns {Promise<import('dictionary-database').KanjiMeta[]>}
     */
    async findKanjiMetaBulk(kanjiList, dictionaryNames) {
        const hoshidicts = await this._getHoshidicts();
        const enabled = new Set(dictionaryNames);
        const rowLists = hoshidicts.findKanjiMeta(kanjiList);
        /** @type {import('dictionary-database').KanjiMeta[]} */
        const results = [];
        for (let index = 0, ii = rowLists.length; index < ii; ++index) {
            for (const {dict_name: dictionary, expression: character, mode, data} of rowLists[index]) {
                if (!enabled.has(dictionary) || mode !== 'freq') { continue; }
                results.push({index, character, mode, data: parseJson(data), dictionary});
            }
        }
        return results;
    }

    /**
     * @param {import('dictionary-database').DictionaryAndQueryRequest[]} items
     * @returns {Promise<(import('dictionary-database').Tag|undefined)[]>}
     */
    async findTagMetaBulk(items) {
        await this._ensurePrepared();
        return items.map(({query, dictionary}) => this._dictionaryMap.get(dictionary)?.tags.get(`${query}`));
    }

    /**
     * @param {string} name
     * @param {string} dictionary
     * @returns {Promise<?import('dictionary-database').Tag>}
     */
    async findTagForTitle(name, dictionary) {
        await this._ensurePrepared();
        return this._dictionaryMap.get(dictionary)?.tags.get(name) ?? null;
    }

    /**
     * @param {import('dictionary-database').MediaRequest[]} items
     * @returns {Promise<import('dictionary-database').Media[]>}
     */
    async getMedia(items) {
        const hoshidicts = await this._getHoshidicts();
        /** @type {import('dictionary-database').Media[]} */
        const results = [];
        for (let index = 0, ii = items.length; index < ii; ++index) {
            const {path, dictionary} = items[index];
            const size = this._dictionaryMap.get(dictionary)?.media.get(path);
            const mediaType = getImageMediaTypeFromFileName(path);
            if (typeof size === 'undefined' || mediaType === null) { continue; }
            const content = hoshidicts.getMedia(dictionary, path);
            if (content === null) { continue; }
            const [width, height] = size;
            results.push({index, dictionary, path, mediaType, width, height, content});
        }
        return results;
    }

    /**
     * Renders images into the canvases of the display that `source` is connected to.
     * @param {import('dictionary-database').DrawMediaRequest[]} items
     * @param {MessagePort} source
     */
    async drawMedia(items, source) {
        safePerformance.mark('drawMedia:start');

        // Merge items with the same path to read each image once. Collects the canvases into a single array for each path.
        /** @type {Map<string, import('dictionary-database').DrawMediaGroupedRequest>} */
        const groupedItems = new Map();
        for (const item of items) {
            const {path, dictionary, canvasIndex, canvasWidth, canvasHeight, generation} = item;
            const key = `${path}:::${dictionary}`;
            let group = groupedItems.get(key);
            if (typeof group === 'undefined') {
                group = {path, dictionary, canvasIndexes: [], canvasWidth, canvasHeight, generation};
                groupedItems.set(key, group);
            }
            group.canvasIndexes.push(canvasIndex);
        }
        const groupedItemsArray = [...groupedItems.values()];
        const media = await this.getMedia(groupedItemsArray);
        /** @type {import('dictionary-database').DrawMedia[]} */
        const results = media.map((m) => {
            const {canvasIndexes, canvasWidth, canvasHeight, generation} = groupedItemsArray[m.index];
            return {...m, canvasIndexes, canvasWidth, canvasHeight, generation};
        });

        // move all svgs to front to have a hotter loop
        results.sort((a, _b) => (a.mediaType === 'image/svg+xml' ? -1 : 1));

        safePerformance.mark('drawMedia:draw:start');
        for (const m of results) {
            if (m.mediaType === 'image/svg+xml') {
                safePerformance.mark('drawMedia:draw:svg:start');
                const fontBuffer = await this._prepareResvg();
                /** @type {import('@resvg/resvg-wasm').ResvgRenderOptions} */
                const opts = {
                    fitTo: {
                        mode: 'width',
                        value: m.canvasWidth,
                    },
                    font: {
                        fontBuffers: [fontBuffer],
                    },
                };
                const resvgJS = new Resvg(new Uint8Array(m.content), opts);
                const render = resvgJS.render();
                source.postMessage({action: 'drawBufferToCanvases', params: {buffer: render.pixels.buffer, width: render.width, height: render.height, canvasIndexes: m.canvasIndexes, generation: m.generation}}, [render.pixels.buffer]);
                safePerformance.mark('drawMedia:draw:svg:end');
                safePerformance.measure('drawMedia:draw:svg', 'drawMedia:draw:svg:start', 'drawMedia:draw:svg:end');
            } else {
                safePerformance.mark('drawMedia:draw:raster:start');

                // ImageDecoder is slightly faster than Blob/createImageBitmap, but
                // 1) it is not available in Firefox <133
                // 2) it is available in Firefox >=133, but it's not possible to transfer VideoFrames cross-process
                //
                // So the second branch is a fallback for all versions of Firefox and doesn't use ImageDecoder at all
                // The second branch can eventually be changed to use ImageDecoder when we are okay with dropping support for Firefox <133
                // The branches can be unified entirely when Firefox implements support for transferring VideoFrames cross-process in postMessage
                if ('serviceWorker' in navigator) { // this is just a check for chrome, we don't actually use service worker functionality here
                    const imageDecoder = new ImageDecoder({type: m.mediaType, data: m.content});
                    await imageDecoder.decode().then((decodedImageResult) => {
                        source.postMessage({action: 'drawDecodedImageToCanvases', params: {decodedImage: decodedImageResult.image, canvasIndexes: m.canvasIndexes, generation: m.generation}}, [decodedImageResult.image]);
                    });
                } else {
                    const image = new Blob([m.content], {type: m.mediaType});
                    await createImageBitmap(image, {resizeWidth: m.canvasWidth, resizeHeight: m.canvasHeight, resizeQuality: 'high'}).then((decodedImage) => {
                        // we need to do a dumb hack where we convert this ImageBitmap to an ImageData by drawing it to a temporary canvas, because Firefox doesn't support transferring ImageBitmaps cross-process
                        const canvas = new OffscreenCanvas(decodedImage.width, decodedImage.height);
                        const ctx = canvas.getContext('2d');
                        if (ctx !== null) {
                            ctx.drawImage(decodedImage, 0, 0);
                            const imageData = ctx.getImageData(0, 0, decodedImage.width, decodedImage.height);
                            source.postMessage({action: 'drawBufferToCanvases', params: {buffer: imageData.data.buffer, width: decodedImage.width, height: decodedImage.height, canvasIndexes: m.canvasIndexes, generation: m.generation}}, [imageData.data.buffer]);
                        }
                    });
                }
                safePerformance.mark('drawMedia:draw:raster:end');
                safePerformance.measure('drawMedia:draw:raster', 'drawMedia:draw:raster:start', 'drawMedia:draw:raster:end');
            }
        }
        safePerformance.mark('drawMedia:draw:end');
        safePerformance.measure('drawMedia:draw', 'drawMedia:draw:start', 'drawMedia:draw:end');

        safePerformance.mark('drawMedia:end');
        safePerformance.measure('drawMedia', 'drawMedia:start', 'drawMedia:end');
    }

    /**
     * @returns {Promise<import('dictionary-importer').Summary[]>}
     */
    async getDictionaryInfo() {
        await this._ensurePrepared();
        return this._dictionaries.map(({record}) => record.summary);
    }

    /**
     * @param {string[]} dictionaryNames
     * @param {boolean} getTotal
     * @returns {Promise<import('dictionary-database').DictionaryCounts>}
     */
    async getDictionaryCounts(dictionaryNames, getTotal) {
        await this._ensurePrepared();
        /** @type {import('dictionary-database').DictionaryCountGroup} */
        let total = {kanji: 0, kanjiMeta: 0, terms: 0, termMeta: 0, tagMeta: 0, media: 0};
        for (const {record} of this._dictionaries) {
            total = addCounts(total, createCountGroup(record.summary.counts));
        }
        const counts = dictionaryNames.map((name) => {
            const dictionary = this._dictionaryMap.get(name);
            return createCountGroup(typeof dictionary !== 'undefined' ? dictionary.record.summary.counts : void 0);
        });
        return {total: getTotal ? total : null, counts};
    }

    /**
     * @param {string} title
     * @returns {Promise<boolean>}
     */
    async dictionaryExists(title) {
        await this._ensurePrepared();
        return this._dictionaryMap.has(title);
    }

    // Private

    /**
     * @template [T=void]
     * @param {() => Promise<T>} task
     * @returns {Promise<T>}
     */
    _enqueue(task) {
        const promise = this._queue.then(task);
        this._queue = promise.then(() => {}, () => {});
        return promise;
    }

    /**
     * @throws {Error}
     */
    _ensureOpen() {
        if (!this._prepared) { throw new Error('Database not open'); }
    }

    /** */
    async _ensurePrepared() {
        this._ensureOpen();
        await this._queue;
    }

    /**
     * Reads the stored dictionaries. Must run in the queue.
     */
    async _readDictionaries() {
        const stored = await this._storage.getDictionaries();
        stored.sort((a, b) => (a.record.summary.importDate - b.record.summary.importDate) || (a.id < b.id ? -1 : (a.id > b.id ? 1 : 0)));
        this._dictionaries = stored.map(({id, record}, index) => ({
            id,
            index,
            record,
            media: new Map(Object.entries(record.media)),
            tags: createTagMap(record),
        }));
        this._dictionaryMap = new Map(this._dictionaries.map((dictionary) => [dictionary.record.summary.title, dictionary]));
        this._mountStale = true;
    }

    /**
     * Returns the engine with the stored dictionaries mounted.
     * @returns {Promise<Hoshidicts>}
     */
    async _getHoshidicts() {
        await this._ensurePrepared();
        if (this._mountStale || this._hoshidicts === null) {
            await this._enqueue(() => this._mountDictionaries());
        }
        return /** @type {Hoshidicts} */ (this._hoshidicts);
    }

    /**
     * Mounts the dictionaries that are not and unmounts those that were removed. Must run in the queue.
     */
    async _mountDictionaries() {
        if (!this._mountStale && this._hoshidicts !== null) { return; }
        if (this._hoshidicts === null) {
            this._hoshidicts = await Hoshidicts.create(isCrossOriginIsolated() ? 0 : null);
            this._hoshidicts.fs.mkdir(MOUNT_DIRECTORY);
        }
        const hoshidicts = this._hoshidicts;
        const ids = new Set(this._dictionaries.map(({id}) => id));
        for (const id of this._mounted.keys()) {
            if (!ids.has(id)) { this._unmount(id); }
        }
        for (const {id, record} of this._dictionaries) {
            if (this._mounted.has(id)) { continue; }
            const path = `${MOUNT_DIRECTORY}/${id}`;
            try {
                const mount = await this._storage.mount(hoshidicts, id, path);
                mount();
                this._mounted.set(id, path);
                if (!hoshidicts.add(path, true)) {
                    throw new Error('hoshidicts could not open it');
                }
            } catch (e) {
                log.error(new Error(`Could not load dictionary ${record.summary.title}: ${e instanceof Error ? e.message : `${e}`}`));
            }
        }
        this._mountStale = false;
    }

    /**
     * @param {string} id
     */
    _unmount(id) {
        const path = this._mounted.get(id);
        if (typeof path === 'undefined' || this._hoshidicts === null) { return; }
        this._mounted.delete(id);
        this._hoshidicts.remove(path);
        this._storage.unmount(this._hoshidicts, path);
    }

    /** */
    _unmountAll() {
        for (const id of this._mounted.keys()) {
            this._unmount(id);
        }
        this._mountStale = true;
    }

    /**
     * @param {import('hoshidicts').TermRow} row
     * @returns {?number}
     */
    _getTermId(row) {
        const dictionary = this._dictionaryMap.get(row.dict_name);
        return typeof dictionary !== 'undefined' ? dictionary.index * ID_SCALE + row.offset : null;
    }

    /**
     * Creates a term entry whose glossary content is left to `findTermGlossariesBulk`.
     * @param {import('hoshidicts').TermRow} row
     * @param {number} id
     * @param {import('dictionary-database').MatchSource} matchSource
     * @param {number} index
     * @returns {import('dictionary-database').TermEntry}
     */
    _createTerm(row, id, matchSource, index) {
        return {
            index,
            matchType: 'exact',
            matchSource,
            term: row.expression,
            reading: row.reading,
            definitionTags: splitField(row.definition_tags),
            termTags: splitField(row.term_tags),
            rules: splitField(row.rules),
            definitions: row.redirects.map(({form_of: formOf, rules}) => [formOf, rules]),
            deferredDefinitionCount: row.content_count,
            score: row.score,
            dictionary: row.dict_name,
            id,
            sequence: row.sequence,
        };
    }

    /**
     * Gives a stored glossary the form Yomitan's importer gave glossaries: text objects become strings,
     * and images gain the size of their file.
     * @param {unknown[]} glossary
     * @param {Map<string, [width: number, height: number]>} media
     * @returns {import('dictionary-data').TermGlossary[]}
     */
    _normalizeGlossary(glossary, media) {
        return glossary.map((item) => {
            if (typeof item !== 'object' || item === null || Array.isArray(item)) {
                return /** @type {import('dictionary-data').TermGlossary} */ (item);
            }
            const data = /** @type {import('dictionary-data').TermGlossaryText|import('dictionary-data').TermGlossaryImage|import('dictionary-data').TermGlossaryStructuredContent} */ (item);
            switch (data.type) {
                case 'text':
                    return data.text;
                case 'image':
                    return /** @type {import('dictionary-data').TermGlossaryImage} */ (createImage({type: 'image', path: ''}, data, media));
                case 'structured-content':
                    return {type: 'structured-content', content: prepareStructuredContent(data.content, media)};
                default:
                    return /** @type {import('dictionary-data').TermGlossary} */ (item);
            }
        });
    }

    /**
     * @returns {Promise<Uint8Array>}
     */
    _prepareResvg() {
        if (this._resvgPromise === null) {
            this._resvgPromise = (async () => {
                await initWasm(fetch('/lib/resvg.wasm'));
                const font = await fetch('/fonts/NotoSansJP-Regular.ttf');
                return new Uint8Array(await font.arrayBuffer());
            })();
        }
        return this._resvgPromise;
    }
}

/**
 * @param {unknown} field
 * @returns {string[]}
 */
function splitField(field) {
    return typeof field === 'string' && field.length > 0 ? field.split(' ') : [];
}

/**
 * @param {import('dictionary-database').DictionaryRecord} record
 * @returns {Map<string, import('dictionary-database').Tag>}
 */
function createTagMap(record) {
    const dictionary = record.summary.title;
    /** @type {Map<string, import('dictionary-database').Tag>} */
    const tags = new Map();
    for (const [name, category, order, notes, score] of record.tags) {
        // The first row of a name is the one found.
        if (tags.has(name)) { continue; }
        tags.set(name, {name, category, order, notes, score, dictionary});
    }
    return tags;
}

/**
 * @param {import('dictionary-importer').SummaryCounts|undefined} counts
 * @returns {import('dictionary-database').DictionaryCountGroup}
 */
function createCountGroup(counts) {
    return {
        kanji: counts?.kanji.total ?? 0,
        kanjiMeta: counts?.kanjiMeta.total ?? 0,
        terms: counts?.terms.total ?? 0,
        termMeta: counts?.termMeta.total ?? 0,
        tagMeta: counts?.tagMeta.total ?? 0,
        media: counts?.media.total ?? 0,
    };
}

/**
 * @param {import('dictionary-database').DictionaryCountGroup} a
 * @param {import('dictionary-database').DictionaryCountGroup} b
 * @returns {import('dictionary-database').DictionaryCountGroup}
 */
function addCounts(a, b) {
    /** @type {import('dictionary-database').DictionaryCountGroup} */
    const result = {};
    for (const [key, value] of Object.entries(a)) {
        result[key] = value + (b[key] ?? 0);
    }
    return result;
}

/**
 * @param {import('structured-content').Content} content
 * @param {Map<string, [width: number, height: number]>} media
 * @returns {import('structured-content').Content}
 */
function prepareStructuredContent(content, media) {
    if (typeof content === 'string' || !(typeof content === 'object' && content !== null)) {
        return content;
    }
    if (Array.isArray(content)) {
        for (let i = 0, ii = content.length; i < ii; ++i) {
            content[i] = prepareStructuredContent(content[i], media);
        }
        return content;
    }
    if (content.tag === 'img') {
        const {verticalAlign, border, borderRadius, sizeUnits} = content;
        /** @type {import('structured-content').ImageElement} */
        const target = createImage({tag: 'img', path: ''}, content, media);
        if (typeof verticalAlign === 'string') { target.verticalAlign = verticalAlign; }
        if (typeof border === 'string') { target.border = border; }
        if (typeof borderRadius === 'string') { target.borderRadius = borderRadius; }
        if (typeof sizeUnits === 'string') { target.sizeUnits = sizeUnits; }
        return target;
    }
    const childContent = content.content;
    if (typeof childContent !== 'undefined') {
        content.content = prepareStructuredContent(childContent, media);
    }
    return content;
}

/**
 * @template {import('structured-content').ImageElementBase} T
 * @param {T} target
 * @param {import('structured-content').ImageElementBase} source
 * @param {Map<string, [width: number, height: number]>} media
 * @returns {T}
 */
function createImage(target, source, media) {
    const {
        path,
        width: preferredWidth,
        height: preferredHeight,
        title,
        alt,
        description,
        pixelated,
        imageRendering,
        appearance,
        background,
        collapsed,
        collapsible,
    } = source;
    const size = media.get(path);
    target.path = path;
    if (typeof size !== 'undefined') {
        [target.width, target.height] = size;
    }
    if (typeof preferredWidth === 'number') { target.preferredWidth = preferredWidth; }
    if (typeof preferredHeight === 'number') { target.preferredHeight = preferredHeight; }
    if (typeof title === 'string') { target.title = title; }
    if (typeof alt === 'string') { target.alt = alt; }
    if (typeof description === 'string') { target.description = description; }
    if (typeof pixelated === 'boolean') { target.pixelated = pixelated; }
    if (typeof imageRendering === 'string') { target.imageRendering = imageRendering; }
    if (typeof appearance === 'string') { target.appearance = appearance; }
    if (typeof background === 'boolean') { target.background = background; }
    if (typeof collapsed === 'boolean') { target.collapsed = collapsed; }
    if (typeof collapsible === 'boolean') { target.collapsible = collapsible; }
    return target;
}
