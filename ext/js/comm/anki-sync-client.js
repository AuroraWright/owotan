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

import {decompress} from '../../lib/fzstd.js';
import {
    Uint8ArrayReader as Uint8ArrayReader0,
    Uint8ArrayWriter as Uint8ArrayWriter0,
    ZipWriter as ZipWriter0,
} from '../../lib/zip.js';
import {parseJson} from '../core/json.js';
import {isObjectNotArray} from '../core/object-utilities.js';
import {generateId} from '../core/utilities.js';

const Uint8ArrayReader = /** @type {typeof import('@zip.js/zip.js').Uint8ArrayReader} */ (/** @type {unknown} */ (Uint8ArrayReader0));
const Uint8ArrayWriter = /** @type {typeof import('@zip.js/zip.js').Uint8ArrayWriter} */ (/** @type {unknown} */ (Uint8ArrayWriter0));
const ZipWriter = /** @type {typeof import('@zip.js/zip.js').ZipWriter} */ (/** @type {unknown} */ (ZipWriter0));

/**
 * The version of the sync protocol that Anki 2.1.57 and newer use.
 */
const SYNC_VERSION = 11;

/**
 * The release of Anki whose client this one identifies as, since sync servers only expect Anki's clients.
 */
const ANKI_VERSION = '26.09.4';
const ANKI_BUILD_HASH = 'c06370ff';

/**
 * The largest block that a zstd frame can hold.
 */
const ZSTD_MAX_BLOCK_SIZE = 128 * 1024;

/**
 * The most media files that a server takes in one upload (MAX_MEDIA_FILES_IN_ZIP in Anki's source).
 */
export const MAX_MEDIA_FILES_PER_UPLOAD = 25;

export class AnkiSyncError extends Error {
    /**
     * @param {string} message
     * @param {number} status The HTTP status of the server's response.
     */
    constructor(message, status) {
        super(message);
        /** @type {string} */
        this.name = 'AnkiSyncError';
        /** @type {number} */
        this.status = status;
    }
}

/**
 * A client of the protocol that Anki syncs collections with (rslib/src/sync in Anki's source). It only reads a collection: a sync it starts is always aborted, which drops what the
 * server would have changed. It can add files to the collection's media, which Anki's clients download when they sync.
 */
export class AnkiSyncClient {
    /**
     * @param {string} endpoint The server's URL, which the methods' paths are relative to.
     * @param {string} hostKey The key that logging in gives, or an empty string to log in.
     * @param {string} platform The name of the operating system, as Anki gives it (`macos`, `windows`, `linux`, `ios`).
     */
    constructor(endpoint, hostKey, platform) {
        /** @type {string} */
        this._endpoint = endpoint;
        /** @type {string} */
        this._hostKey = hostKey;
        /** @type {string} */
        this._platform = platform;
        /** @type {string} */
        this._sessionKey = generateId(8);
    }

    /**
     * The server's URL, which changes if the server redirects to another one.
     * @type {string}
     */
    get endpoint() {
        return this._endpoint;
    }

    /**
     * @param {string} username
     * @param {string} password
     * @returns {Promise<string>} The host key, which is used instead of the password from then on.
     * @throws {AnkiSyncError}
     */
    async login(username, password) {
        const result = await this._request('hostKey', {u: username, p: password});
        if (!isObjectNotArray(result) || typeof result.key !== 'string') {
            throw new AnkiSyncError('The sync server did not log in', 200);
        }
        this._hostKey = result.key;
        return result.key;
    }

    /**
     * Describes the collection without starting a sync, which would interrupt another one.
     * @returns {Promise<import('anki-sync').Meta>}
     */
    async meta() {
        const result = await this._request('meta', {v: SYNC_VERSION, cv: this._getClientVersion()});
        if (
            !isObjectNotArray(result) ||
            typeof result.mod !== 'number' ||
            typeof result.scm !== 'number' ||
            typeof result.usn !== 'number'
        ) {
            throw new AnkiSyncError('The sync server described the collection in a way that cannot be read', 200);
        }
        return {
            mod: result.mod,
            scm: result.scm,
            usn: result.usn,
            cont: result.cont !== false,
            msg: typeof result.msg === 'string' ? result.msg : '',
        };
    }

    /**
     * Starts a sync, which aborts any other sync of the collection that is running.
     * @param {number} minUsn Objects changed in the syncs from this one on are sent.
     * @returns {Promise<import('anki-sync').Graves>} The objects deleted since.
     */
    async start(minUsn) {
        const result = await this._request('start', {minUsn, lnewer: false});
        if (!isObjectNotArray(result)) {
            throw new AnkiSyncError('The sync server sent deleted objects that cannot be read', 200);
        }
        return {
            cards: getNumbers(result.cards),
            notes: getNumbers(result.notes),
            decks: getNumbers(result.decks),
        };
    }

    /**
     * Sends no changes, and gets the server's changed note types and decks.
     * @returns {Promise<import('anki-sync').Changes>}
     */
    async applyChanges() {
        const result = await this._request('applyChanges', {changes: {models: [], decks: [[], []], tags: []}});
        if (!isObjectNotArray(result)) {
            throw new AnkiSyncError('The sync server sent changes that cannot be read', 200);
        }
        /** @type {import('anki-sync').Notetype[]} */
        const notetypes = [];
        if (Array.isArray(result.models)) {
            for (const model of result.models) {
                if (!isObjectNotArray(model) || typeof model.id !== 'number' || typeof model.name !== 'string' || !Array.isArray(model.flds)) { continue; }
                /** @type {{name: string, ord: number}[]} */
                const fields = [];
                for (const field of model.flds) {
                    if (isObjectNotArray(field) && typeof field.name === 'string' && typeof field.ord === 'number') {
                        fields.push({name: field.name, ord: field.ord});
                    }
                }
                fields.sort((a, b) => a.ord - b.ord);
                notetypes.push({id: model.id, name: model.name, fieldNames: fields.map(({name}) => name)});
            }
        }
        /** @type {import('anki-sync').Deck[]} */
        const decks = [];
        /** @type {unknown} */
        const deckList = Array.isArray(result.decks) ? result.decks[0] : null;
        if (Array.isArray(deckList)) {
            for (const deck of deckList) {
                if (!isObjectNotArray(deck) || typeof deck.id !== 'number' || typeof deck.name !== 'string') { continue; }
                decks.push({id: deck.id, name: deck.name, filtered: deck.dyn === 1 || deck.dyn === true});
            }
        }
        return {notetypes, decks};
    }

    /**
     * Gets the next changed notes, cards and reviews. Each chunk takes one of each in turn until it is full.
     * @returns {Promise<import('anki-sync').Chunk>}
     */
    async chunk() {
        const result = await this._request('chunk', {});
        if (!isObjectNotArray(result)) {
            throw new AnkiSyncError('The sync server sent changes that cannot be read', 200);
        }
        /** @type {import('anki-sync').ChunkNote[]} */
        const notes = [];
        if (Array.isArray(result.notes)) {
            // [id, guid, mid, mod, usn, tags, fields, sfld, csum, flags, data]
            for (const note of result.notes) {
                if (!Array.isArray(note) || typeof note[0] !== 'number' || typeof note[2] !== 'number' || typeof note[6] !== 'string') { continue; }
                notes.push({id: note[0], notetypeId: note[2], fields: note[6].split('\u001f')});
            }
        }
        /** @type {import('anki-sync').ChunkCard[]} */
        const cards = [];
        if (Array.isArray(result.cards)) {
            // [id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data]
            for (const card of result.cards) {
                if (!Array.isArray(card) || typeof card[0] !== 'number' || typeof card[1] !== 'number' || typeof card[2] !== 'number') { continue; }
                // A card in a filtered deck keeps its own deck as odid
                /** @type {unknown} */
                const originalDeckId = card[15];
                const deckId = typeof originalDeckId === 'number' && originalDeckId !== 0 ? originalDeckId : card[2];
                cards.push({id: card[0], noteId: card[1], deckId});
            }
        }
        const reviewCount = Array.isArray(result.revlog) ? result.revlog.length : 0;
        return {done: result.done === true, notes, cards, reviewCount};
    }

    /**
     * Ends the sync without keeping anything that it changed.
     */
    async abort() {
        await this._request('abort', {});
    }

    /**
     * Starts a media sync, as Anki does before it sends media files.
     * @returns {Promise<number>} The number of the server's last change to the media.
     * @throws {AnkiSyncError}
     */
    async beginMediaSync() {
        const result = await this._requestMedia('begin', new TextEncoder().encode(JSON.stringify({v: this._getClientVersion()})));
        if (!isObjectNotArray(result) || typeof result.usn !== 'number') {
            throw new AnkiSyncError('The sync server did not start a media sync', 200);
        }
        return result.usn;
    }

    /**
     * Adds files to the collection's media, or replaces the files of the same names.
     * @param {{fileName: string, content: Uint8Array}[]} files At most `MAX_MEDIA_FILES_PER_UPLOAD`, whose names are in NFC.
     * @throws {AnkiSyncError}
     */
    async uploadMediaFiles(files) {
        const result = await this._requestMedia('uploadChanges', await createMediaUploadZip(files));
        // [processed, current_usn]
        if (!Array.isArray(result) || result[0] !== files.length) {
            throw new AnkiSyncError('The sync server did not take all the media files', 200);
        }
    }

    // Private

    /**
     * @returns {string} The version of Anki's client, as Anki gives it.
     */
    _getClientVersion() {
        return `anki,${ANKI_VERSION} (${ANKI_BUILD_HASH}),${this._platform}`;
    }

    /**
     * @param {string} method
     * @param {unknown} data
     * @returns {Promise<unknown>}
     * @throws {AnkiSyncError}
     */
    async _request(method, data) {
        return await this._send(`sync/${method}`, new TextEncoder().encode(JSON.stringify(data)));
    }

    /**
     * @param {string} method
     * @param {Uint8Array} body
     * @returns {Promise<unknown>} What the method returns, which the server wraps with an error message.
     * @throws {AnkiSyncError}
     */
    async _requestMedia(method, body) {
        const result = await this._send(`msync/${method}`, body);
        if (!isObjectNotArray(result)) {
            throw new AnkiSyncError('The sync server sent a media response that cannot be read', 200);
        }
        if (typeof result.err === 'string' && result.err.length > 0) {
            throw new AnkiSyncError(`The sync server answered with the error: ${result.err}`, 200);
        }
        return result.data;
    }

    /**
     * @param {string} path
     * @param {Uint8Array} body
     * @returns {Promise<unknown>}
     * @throws {AnkiSyncError}
     */
    async _send(path, body) {
        const response = await this._fetch(path, body);
        if (response.redirected) {
            // A server can move an account to another server with a permanent redirect to that server's own URL,
            // which is the endpoint from then on. Browsers follow it, but they do not show where it led before that.
            this._endpoint = new URL(response.url.replace(/m?sync\/[^/]*$/, '')).href;
            return await this._getResponseData(await this._fetch(path, body));
        }
        return await this._getResponseData(response);
    }

    /**
     * @param {string} path
     * @param {Uint8Array} data
     * @returns {Promise<Response>}
     * @throws {AnkiSyncError}
     */
    async _fetch(path, data) {
        const header = {v: SYNC_VERSION, k: this._hostKey, c: `${ANKI_VERSION},${ANKI_BUILD_HASH},${this._platform}`, s: this._sessionKey};
        const body = encodeZstdFrame(data);
        try {
            return await fetch(new URL(path, this._endpoint), {
                method: 'POST',
                headers: {'anki-sync': JSON.stringify(header)},
                body,
                cache: 'no-store',
                credentials: 'omit',
            });
        } catch (e) {
            throw new AnkiSyncError(`Cannot connect to the sync server (${e instanceof Error ? e.message : `${e}`})`, 0);
        }
    }

    /**
     * @param {Response} response
     * @returns {Promise<unknown>}
     * @throws {AnkiSyncError}
     */
    async _getResponseData(response) {
        if (!response.ok) {
            throw new AnkiSyncError(await getErrorMessage(response), response.status);
        }
        const compressed = new Uint8Array(await response.arrayBuffer());
        const size = Number.parseInt(response.headers.get('anki-original-size') ?? '', 10);
        /** @type {Uint8Array} */
        let content;
        try {
            // fzstd has no types
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            content = /** @type {Uint8Array} */ (Number.isFinite(size) && size > 0 ? decompress(compressed, new Uint8Array(size)) : decompress(compressed));
        } catch (e) {
            throw new AnkiSyncError(`The sync server sent a response that cannot be decompressed (${e instanceof Error ? e.message : `${e}`})`, response.status);
        }
        return parseJson(new TextDecoder().decode(content));
    }
}

/**
 * @param {Response} response
 * @returns {Promise<string>}
 */
async function getErrorMessage(response) {
    switch (response.status) {
        case 403:
            return 'The username or password is wrong, or the login has expired';
        case 409:
            return 'Another device is syncing the collection';
    }
    let text = '';
    try {
        text = (await response.text()).trim();
    } catch (e) {
        // NOP
    }
    return `The sync server answered with the error ${response.status}${text.length > 0 ? `: ${text.substring(0, 200)}` : ''}`;
}

/**
 * @param {import('environment').OperatingSystem} os
 * @returns {string} The name that Anki gives the operating system.
 */
export function getAnkiPlatformName(os) {
    switch (os) {
        case 'mac': return 'macos';
        case 'win': return 'windows';
        case 'ios': return 'ios';
        case 'android': return 'android';
        default: return 'linux';
    }
}

/**
 * Puts media files in a zip as Anki uploads them: each file is stored under its index, and `_meta` lists each file's
 * name with the name of its entry (rslib/src/sync/media/zip.rs).
 * @param {{fileName: string, content: Uint8Array}[]} files
 * @returns {Promise<Uint8Array>}
 */
async function createMediaUploadZip(files) {
    const zipWriter = new ZipWriter(new Uint8ArrayWriter(), {level: 0});
    // Stored entries need no compression in a worker
    const options = {useWebWorkers: false};
    /** @type {[fileName: string, entryName: string][]} */
    const entries = [];
    for (let i = 0; i < files.length; ++i) {
        const {fileName, content} = files[i];
        await zipWriter.add(`${i}`, new Uint8ArrayReader(content), options);
        entries.push([fileName, `${i}`]);
    }
    await zipWriter.add('_meta', new Uint8ArrayReader(new TextEncoder().encode(JSON.stringify(entries))), options);
    return await zipWriter.close();
}

/**
 * Wraps data in a zstd frame of uncompressed blocks, which the server decodes like any other.
 * @param {Uint8Array} data
 * @returns {Uint8Array}
 */
function encodeZstdFrame(data) {
    const blockCount = Math.max(1, Math.ceil(data.length / ZSTD_MAX_BLOCK_SIZE));
    const frame = new Uint8Array(6 + blockCount * 3 + data.length);
    // Magic number, then a frame header descriptor without a content size, and a 128 KiB window
    frame.set([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x38]);
    let position = 6;
    for (let i = 0; i < blockCount; ++i) {
        const start = i * ZSTD_MAX_BLOCK_SIZE;
        const block = data.subarray(start, start + ZSTD_MAX_BLOCK_SIZE);
        // Last block flag, raw block type (0), and the size
        const blockHeader = (block.length << 3) | (i === blockCount - 1 ? 1 : 0);
        frame[position++] = blockHeader & 0xff;
        frame[position++] = (blockHeader >> 8) & 0xff;
        frame[position++] = (blockHeader >> 16) & 0xff;
        frame.set(block, position);
        position += block.length;
    }
    return frame;
}

/**
 * @param {unknown} value
 * @returns {number[]}
 */
function getNumbers(value) {
    return Array.isArray(value) ? value.filter((item) => typeof item === 'number') : [];
}
