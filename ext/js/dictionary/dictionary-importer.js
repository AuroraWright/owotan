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
import {Hoshidicts} from './hoshidicts.js';

const ajvSchemas = /** @type {import('dictionary-importer').CompiledSchemaValidators} */ (/** @type {unknown} */ (ajvSchemas0));
const BlobWriter = /** @type {typeof import('@zip.js/zip.js').BlobWriter} */ (/** @type {unknown} */ (BlobWriter0));
const TextWriter = /** @type {typeof import('@zip.js/zip.js').TextWriter} */ (/** @type {unknown} */ (TextWriter0));
const Uint8ArrayReader = /** @type {typeof import('@zip.js/zip.js').Uint8ArrayReader} */ (/** @type {unknown} */ (Uint8ArrayReader0));
const ZipReader = /** @type {typeof import('@zip.js/zip.js').ZipReader} */ (/** @type {unknown} */ (ZipReader0));

const INDEX_FILE_NAME = 'index.json';

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
        /** @type {import('dictionary-importer').SummaryCounts} */
        const counts = {
            terms: {total: 0},
            termMeta: {total: 0},
            kanji: {total: 0},
            kanjiMeta: {total: 0},
            tagMeta: {total: 0},
            media: {total: 0},
        };
        // Throws early for an index Yomitan cannot use.
        this._createSummary(dictionaryTitle, version, index, {prefixWildcardsSupported, counts, styles: '', yomitanVersion, importSuccess: false});

        // Files
        this._progressNextStep(0);
        /** @type {import('dictionary-importer').QueryDetails} */
        const queryDetails = [
            ['termFiles', /^term_bank_(\d+)\.json$/],
            ['termMetaFiles', /^term_meta_bank_(\d+)\.json$/],
            ['kanjiFiles', /^kanji_bank_(\d+)\.json$/],
            ['kanjiMetaFiles', /^kanji_meta_bank_(\d+)\.json$/],
            ['tagFiles', /^tag_bank_(\d+)\.json$/],
        ];
        const {termFiles, termMetaFiles, kanjiFiles, kanjiMetaFiles, tagFiles} = Object.fromEntries(this._getArchiveFiles(fileMap, queryDetails));

        // Validate data, counting it and finding the images its glossaries show
        this._progressNextStep(termFiles.length + termMetaFiles.length + kanjiFiles.length + kanjiMetaFiles.length + tagFiles.length);

        /** @type {Map<string, import('dictionary-data').TermV3>} The first term row that shows each image. */
        const imageRows = new Map();
        for (const termFile of termFiles) {
            const entries = /** @type {import('dictionary-data').TermV3[]} */ (await this._readFile(termFile, 'dictionaryTermBankV3'));
            counts.terms.total += entries.length;
            for (const entry of entries) {
                for (const path of getGlossaryImagePaths(entry[5])) {
                    if (!imageRows.has(path)) { imageRows.set(path, entry); }
                }
            }
        }
        for (const termMetaFile of termMetaFiles) {
            const entries = /** @type {import('dictionary-data').TermMeta[]} */ (await this._readFile(termMetaFile, 'dictionaryTermMetaBankV3'));
            addMetaCounts(counts.termMeta, this._getMetaCounts(entries.map(([, mode]) => mode)));
        }
        for (const kanjiFile of kanjiFiles) {
            const entries = /** @type {unknown[]} */ (await this._readFile(kanjiFile, 'dictionaryKanjiBankV3'));
            counts.kanji.total += entries.length;
        }
        for (const kanjiMetaFile of kanjiMetaFiles) {
            const entries = /** @type {import('dictionary-data').KanjiMeta[]} */ (await this._readFile(kanjiMetaFile, 'dictionaryKanjiMetaBankV3'));
            addMetaCounts(counts.kanjiMeta, this._getMetaCounts(entries.map(([, mode]) => mode)));
        }
        /** @type {import('dictionary-database').TagRecord[]} */
        const tags = [];
        for (const tagFile of tagFiles) {
            const tagList = /** @type {import('dictionary-data').Tag[]} */ (await this._readFile(tagFile, 'dictionaryTagBankV3'));
            this._addOldIndexTags(index, tagList);
            tags.push(...tagList);
            counts.tagMeta.total += tagList.length;
        }

        // Read the images' sizes, then have hoshidicts import the dictionary
        this._progressNextStep(imageRows.size + 2);

        /** @type {{[path: string]: [width: number, height: number]}} */
        const media = {};
        for (const [path, entry] of imageRows) {
            const {width, height} = await this._getImageDetails(fileMap, path, entry, dictionaryTitle);
            media[path] = [width, height];
            ++this._progressData.index;
            this._progress();
        }
        counts.media.total = imageRows.size;

        const stylesFileName = 'styles.css';
        const stylesFile = fileMap.get(stylesFileName);
        let styles = '';
        if (typeof stylesFile !== 'undefined') {
            styles = await this._getData(stylesFile, new TextWriter());
            const cssErrors = this._validateCss(styles);
            if (cssErrors.length > 0) {
                return {
                    errors: cssErrors,
                    result: null,
                };
            }
        }

        const files = await this._importArchive(archiveContent);
        ++this._progressData.index;
        this._progress();

        const summary = this._createSummary(dictionaryTitle, version, index, {prefixWildcardsSupported, counts, styles, yomitanVersion, importSuccess: true});
        await dictionaryDatabase.addDictionary(files, {summary, media, tags});
        ++this._progressData.index;
        this._progress();

        this._progressNextStep(0);

        return {result: summary, errors: []};
    }

    /**
     * Imports the archive into a hoshidicts dictionary in memory.
     * @param {ArrayBuffer} archiveContent
     * @returns {Promise<import('dictionary-database').DictionaryFile[]>}
     * @throws {Error}
     */
    async _importArchive(archiveContent) {
        const hoshidicts = await Hoshidicts.create();
        const {fs} = hoshidicts;
        fs.writeFile('/archive.zip', new Uint8Array(archiveContent));
        fs.mkdir('/import');
        const {success, error, directory} = hoshidicts.import('/archive.zip', '/import');
        if (!success) {
            throw new Error(`Could not import dictionary: ${error}`);
        }
        fs.unlink('/archive.zip');
        /** @type {import('dictionary-database').DictionaryFile[]} */
        const files = [];
        for (const name of fs.readdir(directory)) {
            if (name === '.' || name === '..') { continue; }
            files.push({name, content: fs.readFile(`${directory}/${name}`)});
        }
        return files;
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
     * @param {string} css
     * @returns {Error[]}
     */
    _validateCss(css) {
        return css ? [] : [new Error('No styles found')];
    }

    /**
     * @param {import('dictionary-importer').ArchiveFileMap} fileMap
     * @param {string} path
     * @param {import('dictionary-data').TermV3} entry The first term row that shows the image.
     * @param {string} dictionary
     * @returns {Promise<{width: number, height: number}>}
     * @throws {Error}
     */
    async _getImageDetails(fileMap, path, entry, dictionary) {
        /**
         * @param {string} message
         * @returns {Error}
         */
        const createError = (message) => {
            const [expression, reading] = entry;
            const readingSource = reading.length > 0 ? reading : expression;
            return new Error(`${message} at path ${JSON.stringify(path)} for ${expression}${readingSource.length > 0 ? ` (${readingSource})` : ''} in ${dictionary}`);
        };

        const file = fileMap.get(path);
        if (typeof file === 'undefined') {
            throw createError('Could not find image');
        }
        const content = await (await this._getData(file, new BlobWriter())).arrayBuffer();

        const mediaType = getImageMediaTypeFromFileName(path);
        if (mediaType === null) {
            throw createError('Could not determine media type for image');
        }

        try {
            const {width, height} = await this._mediaLoader.getImageDetails(content, mediaType);
            return {width, height};
        } catch (e) {
            throw createError('Could not load image');
        }
    }

    /**
     * Appends the tags of an index's legacy `tagMeta` to a tag bank's rows.
     * @param {import('dictionary-data').Index} index
     * @param {import('dictionary-data').Tag[]} results
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
     * @param {import('dictionary-importer').ArchiveFileMap} fileMap
     * @param {import('dictionary-importer').QueryDetails} queryDetails
     * @returns {import('dictionary-importer').QueryResult}
     */
    _getArchiveFiles(fileMap, queryDetails) {
        /** @type {import('dictionary-importer').QueryResult} */
        const results = new Map();

        for (const [fileType] of queryDetails) {
            results.set(fileType, []);
        }

        for (const [fileName, fileEntry] of fileMap.entries()) {
            for (const [fileType, fileNameFormat] of queryDetails) {
                if (!fileNameFormat.test(fileName)) { continue; }
                const entries = results.get(fileType);

                if (typeof entries !== 'undefined') {
                    entries.push(fileEntry);
                    break;
                }
            }
        }
        return results;
    }

    /**
     * Reads a bank file and validates it against its schema.
     * @param {import('@zip.js/zip.js').Entry} file
     * @param {import('dictionary-importer').CompiledSchemaName} schemaName
     * @returns {Promise<unknown[]>}
     * @throws {Error}
     */
    async _readFile(file, schemaName) {
        const content = await this._getData(file, new TextWriter());
        /** @type {unknown} */
        let entries;
        try {
            entries = parseJson(content);
        } catch (error) {
            throw new Error((error instanceof Error ? error.message : `${error}`) + ` in '${file.filename}'`);
        }

        const schema = ajvSchemas[schemaName];
        if (!schema(entries)) {
            throw this._formatAjvSchemaError(schema, file.filename);
        }

        ++this._progressData.index;
        this._progress();

        return /** @type {unknown[]} */ (entries);
    }

    /**
     * @param {string[]} modes The mode of each row.
     * @returns {import('dictionary-importer').SummaryMetaCount}
     */
    _getMetaCounts(modes) {
        /** @type {Map<string, number>} */
        const countsMap = new Map();
        for (const mode of modes) {
            let count = countsMap.get(mode);
            count = typeof count !== 'undefined' ? count + 1 : 1;
            countsMap.set(mode, count);
        }
        /** @type {import('dictionary-importer').SummaryMetaCount} */
        const counts = {total: modes.length};
        for (const [key, value] of countsMap.entries()) {
            if (Object.prototype.hasOwnProperty.call(counts, key)) { continue; }
            counts[key] = value;
        }
        return counts;
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
 * @param {import('dictionary-importer').SummaryMetaCount} counts
 * @param {import('dictionary-importer').SummaryMetaCount} add
 */
function addMetaCounts(counts, add) {
    for (const [key, value] of Object.entries(add)) {
        counts[key] = (counts[key] ?? 0) + value;
    }
}

/**
 * Finds the paths of the images a term bank row's glossary shows.
 * @param {import('dictionary-data').TermGlossary[]} glossary
 * @returns {string[]}
 */
function getGlossaryImagePaths(glossary) {
    /** @type {string[]} */
    const paths = [];
    for (const item of glossary) {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) { continue; }
        switch (item.type) {
            case 'image':
                paths.push(item.path);
                break;
            case 'structured-content':
                addStructuredContentImagePaths(item.content, paths);
                break;
        }
    }
    return paths;
}

/**
 * @param {import('structured-content').Content} content
 * @param {string[]} paths
 */
function addStructuredContentImagePaths(content, paths) {
    if (typeof content !== 'object' || content === null) { return; }
    if (Array.isArray(content)) {
        for (const child of content) { addStructuredContentImagePaths(child, paths); }
        return;
    }
    if (content.tag === 'img') {
        paths.push(content.path);
        return;
    }
    if (typeof content.content !== 'undefined') {
        addStructuredContentImagePaths(content.content, paths);
    }
}
