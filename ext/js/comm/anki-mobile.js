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

import {log} from '../core/log.js';
import {base64ToArrayBuffer} from '../data/array-buffer-util.js';
import {getFileNameExtension, getImageMediaTypeFromFileName} from '../media/media-util.js';

/**
 * Media files are kept until a note uses them, and the media of a note is stored just before it is added.
 */
const MAX_MEDIA_FILES = 16;

/**
 * The image types that AnkiMobile turns into media files, from a field that is nothing but a `data:` URL of one.
 */
const FILE_IMAGE_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif']);

/**
 * Prefix of the fragment that AnkiMobile adds to the page's URL when it opens the page again after adding a note.
 */
export const ANKI_MOBILE_ADDED_HASH_PREFIX = '#yomitan-anki-added-';

/**
 * Builds the links of AnkiMobile's URL scheme (https://docs.ankimobile.net/url-schemes.html), which is the only
 * way to add notes to Anki on iOS. AnkiMobile adds a note silently, and it opens the link given as `x-success`
 * when it has added it. It cannot store media files, so they are added to the sync server that it syncs with, if
 * Yomitan logged in to it, as Anki would add them, and AnkiMobile gets them when it syncs. Otherwise media are
 * sent in the note: AnkiMobile turns a field that is nothing but a `data:` URL into a media file, and images next
 * to other content, such as a glossary's, and images of the types that it does not turn into files, such as SVG,
 * are kept in the field as `data:` URLs, which cards show.
 */
export class AnkiMobile {
    /**
     * @param {?(files: {fileName: string, content: Uint8Array}[]) => Promise<boolean>} [uploadMediaFiles]
     *   Adds media files to the sync server that AnkiMobile syncs with, and tells whether it did, which it does not
     *   if Yomitan is not logged in to one.
     */
    constructor(uploadMediaFiles = null) {
        /** @type {?(files: {fileName: string, content: Uint8Array}[]) => Promise<boolean>} */
        this._uploadMediaFiles = uploadMediaFiles;
        /** @type {Map<string, string>} */
        this._media = new Map();
    }

    /**
     * Adds a media file to the sync server, or keeps it to send with the note that uses it, as AnkiConnect would
     * store it.
     * @param {string} fileName
     * @param {string} content The file's content, encoded with base64.
     * @returns {Promise<string>} The file name, which the note's fields use.
     * @throws {Error} If the file was not added to a sync server, and its type is not known.
     */
    async storeMediaFile(fileName, content) {
        const ankiFileName = getAnkiMediaFileName(fileName);
        if (await this._uploadMediaFile(ankiFileName, content)) {
            this._media.delete(ankiFileName);
            return ankiFileName;
        }
        const mediaType = getMediaTypeFromFileName(fileName);
        if (mediaType === null) {
            throw new Error(`AnkiMobile cannot add media of the type of ${fileName}`);
        }
        this._media.delete(fileName);
        this._media.set(fileName, `data:${mediaType};base64,${content}`);
        for (const key of this._media.keys()) {
            if (this._media.size <= MAX_MEDIA_FILES) { break; }
            this._media.delete(key);
        }
        return fileName;
    }

    /**
     * @param {import('anki').Note} note
     * @param {boolean} allowDuplicate Whether AnkiMobile adds a note whose first field another note of its type has.
     * @param {?string} successUrl The link AnkiMobile opens once the note was added.
     * @returns {string}
     * @throws {Error} If a field has audio alongside other content, which AnkiMobile cannot add.
     */
    getAddNoteUrl(note, allowDuplicate, successUrl) {
        const {deckName, modelName, tags, fields} = note;
        const parameters = new URLSearchParams();
        parameters.set('type', modelName);
        parameters.set('deck', deckName);
        for (const [name, value] of Object.entries(fields)) {
            parameters.set(`fld${name}`, this._getFieldValue(name, value));
        }
        parameters.set('tags', tags.join(' '));
        if (allowDuplicate) {
            parameters.set('dupes', '1');
        }
        if (successUrl !== null) {
            parameters.set('x-success', successUrl);
        }
        return `anki://x-callback-url/addnote?${toUrlQuery(parameters)}`;
    }

    /**
     * @param {import('anki').NoteId[]} noteIds
     * @returns {string}
     */
    getBrowseNotesUrl(noteIds) {
        const parameters = new URLSearchParams();
        parameters.set('query', `nid:${noteIds.join(',')}`);
        return `anki://x-callback-url/search?${toUrlQuery(parameters)}`;
    }

    /**
     * AnkiMobile puts the profiles, decks and note types on the pasteboard, then opens `successUrl`.
     * @param {string} successUrl
     * @returns {string}
     */
    getInfoForAddingUrl(successUrl) {
        const parameters = new URLSearchParams();
        parameters.set('x-success', successUrl);
        return `anki://x-callback-url/infoForAdding?${toUrlQuery(parameters)}`;
    }

    // Private

    /**
     * @param {string} fileName
     * @param {string} content The file's content, encoded with base64.
     * @returns {Promise<boolean>} Whether the file was added to the sync server.
     */
    async _uploadMediaFile(fileName, content) {
        if (this._uploadMediaFiles === null) { return false; }
        try {
            return await this._uploadMediaFiles([{fileName, content: new Uint8Array(base64ToArrayBuffer(content))}]);
        } catch (e) {
            // The note can still have the file
            log.warn(e);
            return false;
        }
    }

    /**
     * @param {string} name
     * @param {string} value
     * @returns {string}
     * @throws {Error}
     */
    _getFieldValue(name, value) {
        const fileName = getMediaFileName(value.trim());
        if (fileName !== null) {
            const dataUrl = this._media.get(fileName);
            if (typeof dataUrl !== 'undefined' && isFileDataUrl(dataUrl)) { return dataUrl; }
        }
        let result = value;
        for (const [mediaFileName, dataUrl] of this._media) {
            if (!result.includes(mediaFileName)) { continue; }
            if (dataUrl.startsWith('data:image/')) {
                // A glossary's image is in an `img` element, a link and a style attribute's `url()`
                result = result.replaceAll(mediaFileName, dataUrl);
            }
            if (result.includes(mediaFileName)) {
                throw new Error(`AnkiMobile cannot add ${mediaFileName} to the field ${name}, since only images can be added to a field with other content`);
            }
        }
        return result;
    }
}

/**
 * Changes a file name as Anki does when AnkiConnect adds a file (normalize_filename and add_data_to_folder_uniquely
 * in rslib/src/media/files.rs), apart from the rules for names that Yomitan does not make: longer than 120 bytes, or
 * that are Windows device names or end with a space or a dot.
 * @param {string} fileName
 * @returns {string}
 */
function getAnkiMediaFileName(fileName) {
    return fileName
        .normalize('NFC')
        // eslint-disable-next-line no-control-regex
        .replace(/[[\]<>:"/?*^\\|\u0000-\u001f\u007f\p{Cn}]/gu, '')
        .replaceAll('\u00a0', ' ')
        .toLowerCase();
}

/**
 * @param {string} value
 * @returns {?string} The name of the media file if the field is nothing but a sound or image.
 */
function getMediaFileName(value) {
    const match = /^\[sound:([^\]]+)\]$/.exec(value) ?? /^<img src="([^"]+)"\s*\/?>$/.exec(value);
    return match !== null ? match[1] : null;
}

/**
 * @param {string} dataUrl
 * @returns {boolean} Whether AnkiMobile turns a field that is nothing but the `data:` URL into a media file.
 */
function isFileDataUrl(dataUrl) {
    const mediaType = dataUrl.substring('data:'.length, dataUrl.indexOf(';'));
    return mediaType.startsWith('audio/') || FILE_IMAGE_MEDIA_TYPES.has(mediaType);
}

/**
 * @param {string} fileName
 * @returns {?string}
 */
function getMediaTypeFromFileName(fileName) {
    switch (getFileNameExtension(fileName).toLowerCase()) {
        case '.aac':
            return 'audio/aac';
        case '.mp3':
            return 'audio/mpeg';
        case '.m4a':
        case '.mp4':
            return 'audio/mp4';
        case '.oga':
        case '.ogg':
        case '.opus':
            return 'audio/ogg';
        case '.wav':
            return 'audio/wav';
        case '.flac':
            return 'audio/flac';
        case '.webm':
            return 'audio/webm';
        default:
            return getImageMediaTypeFromFileName(fileName);
    }
}

/**
 * URLSearchParams encodes spaces as `+`, which only forms decode as spaces, so they are encoded as `%20`.
 * @param {URLSearchParams} parameters
 * @returns {string}
 */
function toUrlQuery(parameters) {
    return parameters.toString().replace(/\+/g, '%20');
}
