/*
 * Copyright (C) 2023-2026  Yomitan Authors
 * Copyright (C) 2020-2022  Yomichan Authors
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

import * as ajvSchemas0 from '../../lib/validate-schemas.js';
import {
    BlobWriter as BlobWriter0,
    TextWriter as TextWriter0,
    Uint8ArrayReader as Uint8ArrayReader0,
    ZipReader as ZipReader0,
    configure,
} from '../../lib/zip.js';
import {ExtensionError} from '../core/extension-error.js';
import {parseJson} from '../core/json.js';
import {getImageMediaTypeFromFileName} from '../media/media-util.js';
import {compareRevisions} from './dictionary-data-util.js';
import {Hoshidicts, isCrossOriginIsolated} from './hoshidicts.js';

const ajvSchemas = /** @type {import('dictionary-importer').CompiledSchemaValidators} */ (/** @type {unknown} */ (ajvSchemas0));
const BlobWriter = /** @type {typeof import('@zip.js/zip.js').BlobWriter} */ (/** @type {unknown} */ (BlobWriter0));
const TextWriter = /** @type {typeof import('@zip.js/zip.js').TextWriter} */ (/** @type {unknown} */ (TextWriter0));
const Uint8ArrayReader = /** @type {typeof import('@zip.js/zip.js').Uint8ArrayReader} */ (/** @type {unknown} */ (Uint8ArrayReader0));
const ZipReader = /** @type {typeof import('@zip.js/zip.js').ZipReader} */ (/** @type {unknown} */ (ZipReader0));

const INDEX_FILE_NAME = 'index.json';
/** How many images are measured at once. */
const IMAGE_MEASURE_CONCURRENCY = 32;

export class DictionaryImporter {
    /**
     * @param {import('dictionary-importer-media-loader').GenericMediaLoader} mediaLoader
     * @param {import('dictionary-importer').OnProgressCallback} [onProgress]
     */
    constructor(mediaLoader, onProgress) {
        /** @type {import('dictionary-importer-media-loader').GenericMediaLoader} */
        this._mediaLoader = mediaLoader;
        /** @type {import('dictionary-importer').OnProgressCallback} */
        this._onProgress = typeof onProgress === 'function' ? onProgress : () => {};
        /** @type {import('dictionary-importer').ProgressData} */
        this._progressData = this._createProgressData();
    }

    /**
     * Validates a dictionary archive, has hoshidicts import it and stores the result.
     * @param {import('./dictionary-database.js').DictionaryDatabase} dictionaryDatabase
     * @param {ArrayBuffer} archiveContent
     * @param {import('dictionary-importer').ImportDetails} details
     * @returns {Promise<import('dictionary-importer').ImportResult>}
     */
    async importDictionary(dictionaryDatabase, archiveContent, details) {
        if (!dictionaryDatabase) {
            throw new Error('Invalid database');
        }
        if (!dictionaryDatabase.isPrepared()) {
            throw new Error('Database is not ready');
        }

        this._progressReset();

        configure({
            workerScripts: {
                deflate: ['../../lib/z-worker.js'],
                inflate: ['../../lib/z-worker.js'],
            },
        });

        // Read archive
        const fileMap = await this._getFilesFromArchive(archiveContent);
        const index = await this._readAndValidateIndex(fileMap);

        const dictionaryTitle = index.title;
        const version = /** @type {import('dictionary-data').IndexVersion} */ (index.version);
        if (version === 1) {
            throw new Error('Dictionaries in format version 1 are not supported');
        }

        // Verify database is not already imported
        if (await dictionaryDatabase.dictionaryExists(dictionaryTitle)) {
            return {
                errors: [new Error(`Dictionary ${dictionaryTitle} is already imported, skipped it.`)],
                result: null,
            };
        }

        const prefixWildcardsSupported = !!details.prefixWildcardsSupported;
        const yomitanVersion = details.yomitanVersion;
        // Throws early for an index Yomitan cannot use.
        this._createSummary(dictionaryTitle, version, index, {prefixWildcardsSupported, counts: createEmptyCounts(), styles: '', yomitanVersion, importSuccess: false});

        // Have hoshidicts parse, check and import the banks
        this._progressNextStep(0);
        this._progressNextStep(1);
        const {files, report} = await this._importArchive(archiveContent);
        ++this._progressData.index;
        this._progress();

        /** @type {import('dictionary-database').TagRecord[]} */
        const tags = [...report.tags];
        this._addOldIndexTags(index, tags);
        /** @type {import('dictionary-importer').SummaryCounts} */
        const counts = {
            ...report.counts,
            termMeta: createMetaCounts(report.counts.termMeta),
            kanjiMeta: createMetaCounts(report.counts.kanjiMeta),
            tagMeta: {total: tags.length},
            media: {total: report.images.length},
        };

        // Read the sizes of the images the glossaries show, then store the dictionary
        this._progressNextStep(report.images.length + 1);

        const media = await this._getImageSizes(fileMap, report.images, dictionaryTitle);

        const summary = this._createSummary(dictionaryTitle, version, index, {prefixWildcardsSupported, counts, styles: report.styles, yomitanVersion, importSuccess: true});
        await dictionaryDatabase.addDictionary(files, {summary, media, tags});
        ++this._progressData.index;
        this._progress();

        this._progressNextStep(0);

        return {result: summary, errors: []};
    }

    /**
     * Imports the archive into a hoshidicts dictionary in memory. hoshidicts parses the banks, failing for a
     * bank that does not hold the rows its name promises; their contents are not checked further.
     * @param {ArrayBuffer} archiveContent
     * @returns {Promise<{files: import('dictionary-database').DictionaryFile[], report: import('hoshidicts').ImportReport}>}
     * @throws {Error}
     */
    async _importArchive(archiveContent) {
        // Threads share memory, which only a cross-origin isolated context may. The threads' workers last as long
        // as the worker that runs the import.
        const hoshidicts = await Hoshidicts.create(isCrossOriginIsolated() ? Math.min(navigator.hardwareConcurrency || 1, 8) : null);
        const {fs} = hoshidicts;
        fs.writeFile('/archive.zip', new Uint8Array(archiveContent));
        fs.mkdir('/import');
        const report = hoshidicts.import('/archive.zip', '/import');
        const {success, error, directory} = report;
        if (!success) {
            throw new Error(error.startsWith('invalid data') ? `Dictionary has ${error}` : `Could not import dictionary: ${error}`);
        }
        fs.unlink('/archive.zip');
        /** @type {import('dictionary-database').DictionaryFile[]} */
        const files = [];
        for (const name of fs.readdir(directory)) {
            if (name === '.' || name === '..') { continue; }
            files.push({name, content: fs.readFile(`${directory}/${name}`)});
        }
        return {files, report};
    }

    /**
     * @param {ArrayBuffer} archiveContent
     * @returns {Promise<import('dictionary-importer').ArchiveFileMap>}
     */
    async _getFilesFromArchive(archiveContent) {
        const zipFileReader = new Uint8ArrayReader(new Uint8Array(archiveContent));
        const zipReader = new ZipReader(zipFileReader);
        const zipEntries = await zipReader.getEntries();
        /** @type {import('dictionary-importer').ArchiveFileMap} */
        const fileMap = new Map();
        for (const entry of zipEntries) {
            fileMap.set(entry.filename, entry);
        }
        return fileMap;
    }

    /**
     * @param {import('dictionary-importer').ArchiveFileMap} fileMap
     * @returns {?string}
     */
    _findRedundantDirectories(fileMap) {
        let indexPath = '';
        for (const file of fileMap) {
            if (file[0].replace(/.*\//, '') === INDEX_FILE_NAME) {
                indexPath = file[0];
            }
        }
        const redundantDirectoriesRegex = new RegExp(`.*(?=${INDEX_FILE_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`);
        const redundantDirectories = indexPath.match(redundantDirectoriesRegex);
        return redundantDirectories ? redundantDirectories[0] : null;
    }

    /**
     * @param {import('dictionary-importer').ArchiveFileMap} fileMap
     * @returns {Promise<import('dictionary-data').Index>}
     * @throws {Error}
     */
    async _readAndValidateIndex(fileMap) {
        const indexFile = fileMap.get(INDEX_FILE_NAME);
        if (typeof indexFile === 'undefined') {
            const redundantDirectories = this._findRedundantDirectories(fileMap);
            if (redundantDirectories) {
                throw new Error('Dictionary index found nested in redundant directories: "' + redundantDirectories + '" when it must be in the archive\'s root directory');
            }
            throw new Error('No dictionary index found in archive');
        }
        const indexFile2 = /** @type {import('@zip.js/zip.js').Entry} */ (indexFile);

        const indexContent = await this._getData(indexFile2, new TextWriter());
        const index = /** @type {unknown} */ (parseJson(indexContent));

        if (!ajvSchemas.dictionaryIndex(index)) {
            throw this._formatAjvSchemaError(ajvSchemas.dictionaryIndex, INDEX_FILE_NAME);
        }

        const validIndex = /** @type {import('dictionary-data').Index} */ (index);

        const version = typeof validIndex.format === 'number' ? validIndex.format : validIndex.version;
        validIndex.version = version;

        const {title, revision} = validIndex;
        if (typeof version !== 'number' || !title || !revision) {
            throw new Error('Unrecognized dictionary format');
        }

        return validIndex;
    }

    /**
     * @returns {import('dictionary-importer').ProgressData}
     */
    _createProgressData() {
        return {
            index: 0,
            count: 0,
        };
    }

    /** */
    _progressReset() {
        this._progressData = this._createProgressData();
        this._progress(true);
    }

    /**
     * @param {number} count
     */
    _progressNextStep(count) {
        this._progressData.index = 0;
        this._progressData.count = count;
        this._progress(true);
    }

    /**
     * @param {boolean} nextStep
     */
    _progress(nextStep = false) {
        this._onProgress({...this._progressData, nextStep});
    }

    /**
     * @param {string} dictionaryTitle
     * @param {number} version
     * @param {import('dictionary-data').Index} index
     * @param {import('dictionary-importer').SummaryDetails} details
     * @returns {import('dictionary-importer').Summary}
     * @throws {Error}
     */
    _createSummary(dictionaryTitle, version, index, details) {
        const indexSequenced = index.sequenced;
        const {prefixWildcardsSupported, counts, styles, importSuccess} = details;
        /** @type {import('dictionary-importer').Summary} */
        const summary = {
            title: dictionaryTitle,
            revision: index.revision,
            sequenced: typeof indexSequenced === 'boolean' && indexSequenced,
            version,
            importDate: Date.now(),
            prefixWildcardsSupported,
            counts,
            styles,
            importSuccess,
        };

        const {minimumYomitanVersion, author, url, description, attribution, frequencyMode, isUpdatable, sourceLanguage, targetLanguage} = index;
        if (typeof minimumYomitanVersion === 'string') {
            if (details.yomitanVersion === '0.0.0.0') {
                // Running a development version of Yomitan
            } else if (compareRevisions(details.yomitanVersion, minimumYomitanVersion)) {
                throw new Error(`Dictionary is incompatible with this version of Yomitan (${details.yomitanVersion}; minimum required: ${minimumYomitanVersion})`);
            }
            summary.minimumYomitanVersion = minimumYomitanVersion;
        }
        if (typeof author === 'string') { summary.author = author; }
        if (typeof url === 'string') { summary.url = url; }
        if (typeof description === 'string') { summary.description = description; }
        if (typeof attribution === 'string') { summary.attribution = attribution; }
        if (typeof frequencyMode === 'string') { summary.frequencyMode = frequencyMode; }
        if (typeof sourceLanguage === 'string') { summary.sourceLanguage = sourceLanguage; }
        if (typeof targetLanguage === 'string') { summary.targetLanguage = targetLanguage; }
        if (typeof isUpdatable === 'boolean') {
            const {indexUrl, downloadUrl} = index;
            if (!isUpdatable || !this._validateUrl(indexUrl) || !this._validateUrl(downloadUrl)) {
                throw new Error('Invalid index data for updatable dictionary');
            }
            summary.isUpdatable = isUpdatable;
            summary.indexUrl = indexUrl;
            summary.downloadUrl = downloadUrl;
        }
        return summary;
    }

    /**
     * @param {string|undefined} string
     * @returns {boolean}
     */
    _validateUrl(string) {
        if (typeof string !== 'string') {
            return false;
        }

        let url;
        try {
            url = new URL(string);
        } catch (_) {
            return false;
        }

        return url.protocol === 'http:' || url.protocol === 'https:';
    }

    /**
     * @param {import('ajv').ValidateFunction} schema
     * @param {string} fileName
     * @returns {ExtensionError}
     */
    _formatAjvSchemaError(schema, fileName) {
        const e = new ExtensionError(`Dictionary has invalid data in '${fileName}' '${JSON.stringify(schema.errors)}'`);
        e.data = schema.errors;
        return e;
    }

    /**
     * Finds the size of each image. hoshidicts reads most from their headers; the others are decoded by
     * the page that started the import, a round trip from this worker, so several are decoded at once.
     * @param {import('dictionary-importer').ArchiveFileMap} fileMap
     * @param {import('hoshidicts').ImportImage[]} images
     * @param {string} dictionary
     * @returns {Promise<{[path: string]: [width: number, height: number]}>}
     * @throws {Error}
     */
    async _getImageSizes(fileMap, images, dictionary) {
        /** @type {[width: number, height: number][]} */
        const sizes = new Array(images.length);
        let next = 0;
        let failed = false;
        const measure = async () => {
            while (!failed && next < images.length) {
                const index = next++;
                const {path, expression, reading, width, height} = images[index];
                try {
                    if (width > 0 && height > 0) {
                        this._validateImageMediaType(path, expression, reading, dictionary);
                        sizes[index] = [width, height];
                    } else {
                        const details = await this._getImageDetails(fileMap, path, expression, reading, dictionary);
                        sizes[index] = [details.width, details.height];
                    }
                } catch (e) {
                    failed = true;
                    throw e;
                }
                ++this._progressData.index;
                this._progress();
            }
        };
        const measurers = [];
        for (let i = 0, ii = Math.min(IMAGE_MEASURE_CONCURRENCY, images.length); i < ii; ++i) {
            measurers.push(measure());
        }
        await Promise.all(measurers);

        /** @type {{[path: string]: [width: number, height: number]}} */
        const media = {};
        for (let i = 0, ii = images.length; i < ii; ++i) {
            media[images[i].path] = sizes[i];
        }
        return media;
    }

    /**
     * @param {import('dictionary-importer').ArchiveFileMap} fileMap
     * @param {string} path
     * @param {string} expression The expression of the first term row that shows the image.
     * @param {string} reading The reading of that row.
     * @param {string} dictionary
     * @returns {Promise<{width: number, height: number}>}
     * @throws {Error}
     */
    async _getImageDetails(fileMap, path, expression, reading, dictionary) {
        const file = fileMap.get(path);
        if (typeof file === 'undefined') {
            throw this._createImageError('Could not find image', path, expression, reading, dictionary);
        }
        const content = await (await this._getData(file, new BlobWriter())).arrayBuffer();

        const mediaType = this._validateImageMediaType(path, expression, reading, dictionary);

        try {
            const {width, height} = await this._mediaLoader.getImageDetails(content, mediaType);
            return {width, height};
        } catch (e) {
            throw this._createImageError('Could not load image', path, expression, reading, dictionary);
        }
    }

    /**
     * @param {string} path
     * @param {string} expression
     * @param {string} reading
     * @param {string} dictionary
     * @returns {string} The image's media type.
     * @throws {Error}
     */
    _validateImageMediaType(path, expression, reading, dictionary) {
        const mediaType = getImageMediaTypeFromFileName(path);
        if (mediaType === null) {
            throw this._createImageError('Could not determine media type for image', path, expression, reading, dictionary);
        }
        return mediaType;
    }

    /**
     * @param {string} message
     * @param {string} path
     * @param {string} expression The expression of the first term row that shows the image.
     * @param {string} reading The reading of that row.
     * @param {string} dictionary
     * @returns {Error}
     */
    _createImageError(message, path, expression, reading, dictionary) {
        const readingSource = reading.length > 0 ? reading : expression;
        return new Error(`${message} at path ${JSON.stringify(path)} for ${expression}${readingSource.length > 0 ? ` (${readingSource})` : ''} in ${dictionary}`);
    }

    /**
     * Appends the tags of an index's legacy `tagMeta` to a tag bank's rows.
     * @param {import('dictionary-data').Index} index
     * @param {import('dictionary-database').TagRecord[]} results
     */
    _addOldIndexTags(index, results) {
        const {tagMeta} = index;
        if (typeof tagMeta !== 'object' || tagMeta === null) { return; }
        for (const [name, value] of Object.entries(tagMeta)) {
            const {category, order, notes, score} = value;
            results.push([name, category, order, notes, score]);
        }
    }

    /**
     * @template [T=unknown]
     * @param {import('@zip.js/zip.js').Entry} entry
     * @param {import('@zip.js/zip.js').Writer<T>|import('@zip.js/zip.js').WritableWriter} writer
     * @returns {Promise<T>}
     */
    async _getData(entry, writer) {
        if (typeof entry.getData === 'undefined') {
            throw new Error(`Cannot read ${entry.filename}`);
        }
        return await entry.getData(writer);
    }
}

/**
 * hoshidicts reports the modes in name order; the total comes first, as Yomitan always wrote it.
 * @param {{[mode: string]: number}} modes
 * @returns {import('dictionary-importer').SummaryMetaCount}
 */
function createMetaCounts({total, ...modes}) {
    return {total, ...modes};
}

/**
 * @returns {import('dictionary-importer').SummaryCounts}
 */
function createEmptyCounts() {
    return {
        terms: {total: 0},
        termMeta: {total: 0},
        kanji: {total: 0},
        kanjiMeta: {total: 0},
        tagMeta: {total: 0},
        media: {total: 0},
    };
}
