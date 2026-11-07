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

import {AnkiSyncClient, MAX_MEDIA_FILES_PER_UPLOAD} from '../comm/anki-sync-client.js';

const DATABASE_NAME = 'anki-collection-copy';
const DATABASE_VERSION = 1;

/**
 * The background page and the settings page both update the copy, one at a time.
 */
const LOCK_NAME = 'anki-collection-copy';

/**
 * How long a note added through AnkiMobile counts as a duplicate without the copy having it, in milliseconds, if no
 * sync shows that the collection does not have it.
 */
const PENDING_NOTE_LIFETIME = 7 * 24 * 60 * 60 * 1000;

/**
 * Anki's HTML_MEDIA_TAGS (rslib/src/text.rs), whose file names it keeps when it compares fields.
 */
const HTML_MEDIA_TAGS = /<\b(?:img|audio|video|object|source)\b(?:[^>]|"[^"]+?"|'[^']+?')+?\b(?:src|data)\b=(?:"([^"]+?)"[^>]*>|'([^']+?)'[^>]*>|([^ >]+?)(?: [^>]*>|>))/gis;

/**
 * Anki's HTML (rslib/src/text.rs).
 */
const HTML = /<!--.*?-->|<style.*?>.*?<\/style>|<script.*?>.*?<\/script>|<.*?>/gis;

/** @type {Map<string, string>} */
const HTML_ENTITIES = new Map([
    ['amp', '&'],
    ['lt', '<'],
    ['gt', '>'],
    ['quot', '"'],
    ['apos', '\''],
    ['nbsp', '\u00a0'],
]);

/**
 * A copy of what Yomitan needs from an Anki collection on a sync server: the note types,
 * the decks, the first field of each note and the deck of each card. Updating it reads the collection the way
 * Anki syncs it, then aborts the sync, so nothing in the collection changes.
 */
export class AnkiCollectionCopy {
    /**
     * @param {string} platform The name of the operating system, as Anki gives it.
     */
    constructor(platform) {
        /** @type {string} */
        this._platform = platform;
        /** @type {?Promise<IDBDatabase>} */
        this._databasePromise = null;
    }

    /**
     * @returns {Promise<?import('anki-sync').Status>} Null if no login is kept.
     */
    async getStatus() {
        const {login, sync} = await this._getState();
        if (login === null) { return null; }
        const [noteCount] = await this._read(['notes'], (transaction) => [transaction.objectStore('notes').count()]);
        return {
            serverUrl: login.serverUrl,
            username: login.username,
            updatedAt: sync !== null ? sync.updatedAt : null,
            noteCount: /** @type {number} */ (noteCount),
        };
    }

    /**
     * Logs in, and drops the copy of any collection that was kept. The password is not kept.
     * @param {string} serverUrl The URL of the sync server.
     * @param {string} username
     * @param {string} password
     */
    async login(serverUrl, username, password) {
        const client = new AnkiSyncClient(getEndpoint(serverUrl), '', this._platform);
        const hostKey = await client.login(username, password);
        /** @type {import('anki-sync').Login} */
        const login = {serverUrl, endpoint: client.endpoint, username, hostKey};
        await this._withLock(false, async () => {
            await this._clear(true);
            await this._write(['state'], (transaction) => {
                transaction.objectStore('state').put({name: 'login', value: login});
            });
        });
    }

    /**
     * Drops the login and the copy.
     */
    async logout() {
        await this._withLock(false, () => this._clear(true));
    }

    /**
     * Makes the copy the same as the collection, if the collection changed.
     * @param {{minInterval?: number, ifAvailable?: boolean, onProgress?: (progress: import('anki-sync').UpdateProgress) => void}} [details]
     *   `minInterval`: how long after the last check the collection is not checked again, in milliseconds.
     *   `ifAvailable`: whether nothing is done if the copy is being updated already.
     * @returns {Promise<boolean>} Whether the collection was checked.
     */
    async update({minInterval = 0, ifAvailable = false, onProgress} = {}) {
        return await this._withLock(ifAvailable, async () => {
            const {login, sync, checkedAt} = await this._getState();
            if (login === null) { return false; }
            const now = Date.now();
            if (minInterval > 0 && now - checkedAt < minInterval) { return false; }
            await this._write(['state'], (transaction) => {
                transaction.objectStore('state').put({name: 'checkedAt', value: now});
            });

            const client = new AnkiSyncClient(login.endpoint, login.hostKey, this._platform);
            const meta = await client.meta();
            await this._keepEndpoint(login, client);
            if (!meta.cont) {
                throw new Error(meta.msg.length > 0 ? meta.msg : 'The sync server does not allow syncing');
            }

            // A full sync replaces the collection without telling what it deleted, and keeps the objects' usns
            const full = sync === null || sync.scm !== meta.scm || meta.usn < sync.usn;
            if (!full && meta.usn === sync.usn) {
                await this._write(['state'], (transaction) => {
                    transaction.objectStore('state').put({name: 'sync', value: {...sync, updatedAt: now}});
                });
                await this._prunePendingNotes(meta.mod);
                return true;
            }
            if (full) {
                await this._clear(false);
            }
            await this._fetchChanges(client, full ? 0 : sync.usn, onProgress);
            /** @type {import('anki-sync').SyncState} */
            const newSync = {usn: meta.usn, scm: meta.scm, updatedAt: now};
            await this._write(['state'], (transaction) => {
                transaction.objectStore('state').put({name: 'sync', value: newSync});
            });
            await this._prunePendingNotes(meta.mod);
            return true;
        }) ?? false;
    }

    /**
     * Adds files to the collection's media on the sync server, as Anki does, from which Anki's clients download them
     * when they sync.
     * @param {{fileName: string, content: Uint8Array}[]} files Their names are in NFC, as Anki keeps them.
     * @returns {Promise<boolean>} Whether they were added, which they are not if no login is kept.
     */
    async uploadMediaFiles(files) {
        const {login} = await this._getState();
        if (login === null) { return false; }
        const client = new AnkiSyncClient(login.endpoint, login.hostKey, this._platform);
        await client.beginMediaSync();
        await this._keepEndpoint(login, client);
        for (let i = 0; i < files.length; i += MAX_MEDIA_FILES_PER_UPLOAD) {
            await client.uploadMediaFiles(files.slice(i, i + MAX_MEDIA_FILES_PER_UPLOAD));
        }
        return true;
    }

    /**
     * @returns {Promise<?import('anki-sync').CollectionInfo>} Null if the copy has never been updated.
     */
    async getCollectionInfo() {
        if ((await this._getState()).sync === null) { return null; }
        const [notetypes, decks] = await this._read(['notetypes', 'decks'], (transaction) => [
            transaction.objectStore('notetypes').getAll(),
            transaction.objectStore('decks').getAll(),
        ]);
        const deckNames = /** @type {import('anki-sync').Deck[]} */ (decks)
            .filter(({filtered}) => !filtered)
            .map(({name}) => name)
            .sort();
        const models = /** @type {import('anki-sync').Notetype[]} */ (notetypes)
            .map(({name, fieldNames}) => ({name, fieldNames}))
            .sort((a, b) => (a.name < b.name ? -1 : (a.name > b.name ? 1 : 0)));
        return {deckNames, models};
    }

    /**
     * Finds the notes that each note would duplicate, as AnkiConnect does.
     * @param {import('anki').Note[]} notes
     * @returns {Promise<?(?import('anki').NoteId[])[]>} For each note, the ids of the notes it would duplicate, which
     *   are none if it would only duplicate notes added since the copy was updated, or null if it is not a duplicate.
     *   Null if the copy has never been updated.
     */
    async findDuplicates(notes) {
        const {sync, pendingNotes: allPendingNotes} = await this._getState();
        if (sync === null) { return null; }
        const now = Date.now();
        const pendingNotes = allPendingNotes.filter(({addedAt}) => now - addedAt <= PENDING_NOTE_LIFETIME);
        const [notetypeList, deckList] = await this._read(['notetypes', 'decks'], (transaction) => [
            transaction.objectStore('notetypes').getAll(),
            transaction.objectStore('decks').getAll(),
        ]);
        const notetypes = /** @type {import('anki-sync').Notetype[]} */ (notetypeList);
        const decks = /** @type {import('anki-sync').Deck[]} */ (deckList);

        // Anki compares the names of note types and decks without case
        /** @type {Map<string, number>} */
        const notetypeIds = new Map(notetypes.map(({id, name}) => [name.toLowerCase(), id]));

        const keys = notes.map((note) => getNoteKey(note, notetypes));
        const candidateLists = /** @type {import('anki-sync').StoredNote[][]} */ (await this._read(['notes'], (transaction) => {
            const index = transaction.objectStore('notes').index('key');
            return keys.map((key) => index.getAll(key ?? ''));
        }));

        /** @type {{candidates: import('anki-sync').StoredNote[], scopeDeckIds: ?Set<number>, pending: boolean}[]} */
        const checks = [];
        for (let i = 0; i < notes.length; ++i) {
            const key = keys[i];
            const note = notes[i];
            const {duplicateScope, duplicateScopeOptions: {deckName, checkChildren, checkAllModels}} = note.options;
            const modelName = note.modelName.toLowerCase();
            const notetypeId = notetypeIds.get(modelName);
            const scopeDeckName = duplicateScope === 'collection' ? null : (deckName ?? note.deckName).toLowerCase();
            checks.push({
                candidates: key === null ? [] : candidateLists[i].filter((candidate) => checkAllModels || candidate.notetypeId === notetypeId),
                scopeDeckIds: scopeDeckName === null ? null : new Set(decks.filter(({name}) => isDeckInScope(name.toLowerCase(), scopeDeckName, checkChildren)).map(({id}) => id)),
                pending: key !== null && pendingNotes.some((pendingNote) => (
                    pendingNote.key === key &&
                    (checkAllModels || pendingNote.modelName.toLowerCase() === modelName) &&
                    (scopeDeckName === null || isDeckInScope(pendingNote.deckName.toLowerCase(), scopeDeckName, checkChildren))
                )),
            });
        }

        // A note is a duplicate within a deck if one of its cards is in the deck
        const deckCandidates = checks.flatMap(({candidates, scopeDeckIds}) => (scopeDeckIds !== null ? candidates : []));
        /** @type {Map<number, import('anki-sync').StoredCard[]>} */
        const cardsByNote = new Map();
        if (deckCandidates.length > 0) {
            const cardLists = /** @type {import('anki-sync').StoredCard[][]} */ (await this._read(['cards'], (transaction) => {
                const index = transaction.objectStore('cards').index('noteId');
                return deckCandidates.map(({id}) => index.getAll(id));
            }));
            for (let i = 0; i < deckCandidates.length; ++i) {
                cardsByNote.set(deckCandidates[i].id, cardLists[i]);
            }
        }

        return checks.map(({candidates, scopeDeckIds, pending}) => {
            const noteIds = candidates
                .filter(({id}) => scopeDeckIds === null || (cardsByNote.get(id) ?? []).some(({deckId}) => scopeDeckIds.has(deckId)))
                .map(({id}) => id);
            return noteIds.length > 0 || pending ? noteIds : null;
        });
    }

    /**
     * Remembers a note that was added, which the copy only has once it is updated after the note was synced.
     * @param {import('anki').Note} note
     */
    async addPendingNote(note) {
        await this._withLock(false, async () => {
            const [notetypes] = await this._read(['notetypes'], (transaction) => [transaction.objectStore('notetypes').getAll()]);
            const key = getNoteKey(note, /** @type {import('anki-sync').Notetype[]} */ (notetypes));
            if (key === null) { return; }
            const {pendingNotes} = await this._getState();
            pendingNotes.push({key, modelName: note.modelName, deckName: note.deckName, addedAt: Date.now()});
            await this._write(['state'], (transaction) => {
                transaction.objectStore('state').put({name: 'pending', value: pendingNotes});
            });
        });
    }

    // Private

    /**
     * @param {AnkiSyncClient} client
     * @param {number} minUsn
     * @param {((progress: import('anki-sync').UpdateProgress) => void)|undefined} onProgress
     */
    async _fetchChanges(client, minUsn, onProgress) {
        try {
            const graves = await client.start(minUsn);
            const {notetypes, decks} = await client.applyChanges();
            await this._write(['notes', 'cards', 'decks', 'notetypes'], (transaction) => {
                const noteStore = transaction.objectStore('notes');
                const cardStore = transaction.objectStore('cards');
                const deckStore = transaction.objectStore('decks');
                const notetypeStore = transaction.objectStore('notetypes');
                for (const id of graves.notes) { noteStore.delete(id); }
                for (const id of graves.cards) { cardStore.delete(id); }
                for (const id of graves.decks) { deckStore.delete(id); }
                for (const notetype of notetypes) { notetypeStore.put(notetype); }
                for (const deck of decks) { deckStore.put(deck); }
            });

            let noteCount = 0;
            for (;;) {
                const chunk = await client.chunk();
                await this._write(['notes', 'cards'], (transaction) => {
                    const noteStore = transaction.objectStore('notes');
                    const cardStore = transaction.objectStore('cards');
                    for (const {id, notetypeId, fields} of chunk.notes) {
                        /** @type {import('anki-sync').StoredNote} */
                        const storedNote = {id, notetypeId, key: getDuplicateKey(fields[0] ?? '') ?? ''};
                        noteStore.put(storedNote);
                    }
                    for (const card of chunk.cards) { cardStore.put(card); }
                });
                noteCount += chunk.notes.length;
                if (typeof onProgress === 'function') { onProgress({noteCount}); }
                // A chunk takes one note, card and review in turn, so one without notes and cards only has reviews
                // left after it, which are not needed
                if (chunk.done || (chunk.notes.length === 0 && chunk.cards.length === 0)) { break; }
            }
        } finally {
            // Nothing is kept on the server without finishing the sync, which only Anki itself does
            try {
                await client.abort();
            } catch (e) {
                // NOP
            }
        }
    }

    /**
     * Drops the pending notes that the copy has now, and the old ones. It also drops those that the copy does not have
     * although a sync changed the collection after they were added, since AnkiMobile synced after deleting them.
     * The sync could also have been another device's, and then a note does not count until AnkiMobile syncs it.
     * @param {number} collectionModified When a sync last changed the collection, by the server's clock.
     */
    async _prunePendingNotes(collectionModified) {
        const {pendingNotes} = await this._getState();
        if (pendingNotes.length === 0) { return; }
        const [notetypeList] = await this._read(['notetypes'], (transaction) => [transaction.objectStore('notetypes').getAll()]);
        const notetypeIds = new Map(/** @type {import('anki-sync').Notetype[]} */ (notetypeList).map(({id, name}) => [name.toLowerCase(), id]));
        const candidateLists = /** @type {import('anki-sync').StoredNote[][]} */ (await this._read(['notes'], (transaction) => {
            const index = transaction.objectStore('notes').index('key');
            return pendingNotes.map(({key}) => index.getAll(key));
        }));
        const now = Date.now();
        const remaining = pendingNotes.filter((pendingNote, i) => {
            if (now - pendingNote.addedAt > PENDING_NOTE_LIFETIME || pendingNote.addedAt < collectionModified) { return false; }
            const notetypeId = notetypeIds.get(pendingNote.modelName.toLowerCase());
            return !candidateLists[i].some((candidate) => candidate.notetypeId === notetypeId);
        });
        await this._write(['state'], (transaction) => {
            transaction.objectStore('state').put({name: 'pending', value: remaining});
        });
    }

    /**
     * @returns {Promise<{login: ?import('anki-sync').Login, sync: ?import('anki-sync').SyncState, pendingNotes: import('anki-sync').PendingNote[], checkedAt: number}>}
     */
    async _getState() {
        const [records] = await this._read(['state'], (transaction) => [transaction.objectStore('state').getAll()]);
        /** @type {{login: ?import('anki-sync').Login, sync: ?import('anki-sync').SyncState, pendingNotes: import('anki-sync').PendingNote[], checkedAt: number}} */
        const state = {login: null, sync: null, pendingNotes: [], checkedAt: 0};
        for (const record of /** @type {import('anki-sync').StateRecord[]} */ (records)) {
            switch (record.name) {
                case 'login': state.login = record.value; break;
                case 'sync': state.sync = record.value; break;
                case 'pending': state.pendingNotes = record.value; break;
                case 'checkedAt': state.checkedAt = record.value; break;
            }
        }
        return state;
    }

    /**
     * Keeps the endpoint that the server redirected the client to.
     * @param {import('anki-sync').Login} login
     * @param {AnkiSyncClient} client
     */
    async _keepEndpoint(login, client) {
        if (client.endpoint === login.endpoint) { return; }
        await this._write(['state'], (transaction) => {
            transaction.objectStore('state').put({name: 'login', value: {...login, endpoint: client.endpoint}});
        });
    }

    /**
     * @param {boolean} includeLogin
     */
    async _clear(includeLogin) {
        await this._write(['notes', 'cards', 'decks', 'notetypes', 'state'], (transaction) => {
            for (const name of ['notes', 'cards', 'decks', 'notetypes']) {
                transaction.objectStore(name).clear();
            }
            const stateStore = transaction.objectStore('state');
            if (includeLogin) {
                stateStore.clear();
            } else {
                stateStore.delete('sync');
            }
        });
    }

    /**
     * Runs one update of the copy at a time across the extension's pages.
     * @template TResult
     * @param {boolean} ifAvailable Whether to do nothing if another update is running.
     * @param {() => Promise<TResult>} callback
     * @returns {Promise<TResult|null>} Null if nothing was done.
     */
    async _withLock(ifAvailable, callback) {
        const locks = typeof navigator !== 'undefined' ? navigator.locks : void 0;
        if (typeof locks === 'undefined') { return await callback(); }
        return await locks.request(LOCK_NAME, {ifAvailable}, async (lock) => (lock === null ? null : await callback()));
    }

    /**
     * Makes requests in one transaction.
     * @param {string[]} storeNames
     * @param {(transaction: IDBTransaction) => IDBRequest[]} createRequests
     * @returns {Promise<unknown[]>} The requests' results, once the transaction completes.
     */
    async _read(storeNames, createRequests) {
        const database = await this._getDatabase();
        return await new Promise((resolve, reject) => {
            const transaction = database.transaction(storeNames, 'readonly');
            const requests = createRequests(transaction);
            transaction.addEventListener('complete', () => resolve(requests.map((request) => request.result)));
            transaction.addEventListener('error', () => reject(transaction.error));
            transaction.addEventListener('abort', () => reject(transaction.error ?? new Error('The transaction was aborted')));
        });
    }

    /**
     * @param {string[]} storeNames
     * @param {(transaction: IDBTransaction) => void} write
     * @returns {Promise<void>} Once the changes are written.
     */
    async _write(storeNames, write) {
        const database = await this._getDatabase();
        await new Promise((resolve, reject) => {
            const transaction = database.transaction(storeNames, 'readwrite');
            write(transaction);
            transaction.addEventListener('complete', () => resolve(void 0));
            transaction.addEventListener('error', () => reject(transaction.error));
            transaction.addEventListener('abort', () => reject(transaction.error ?? new Error('The transaction was aborted')));
        });
    }

    /**
     * @returns {Promise<IDBDatabase>}
     */
    _getDatabase() {
        if (this._databasePromise === null) {
            this._databasePromise = new Promise((resolve, reject) => {
                const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
                request.addEventListener('upgradeneeded', () => {
                    const database = request.result;
                    database.createObjectStore('notes', {keyPath: 'id'}).createIndex('key', 'key');
                    database.createObjectStore('cards', {keyPath: 'id'}).createIndex('noteId', 'noteId');
                    database.createObjectStore('decks', {keyPath: 'id'});
                    database.createObjectStore('notetypes', {keyPath: 'id'});
                    database.createObjectStore('state', {keyPath: 'name'});
                });
                request.addEventListener('success', () => resolve(request.result));
                request.addEventListener('error', () => {
                    this._databasePromise = null;
                    reject(request.error);
                });
            });
        }
        return this._databasePromise;
    }
}

/**
 * @param {string} serverUrl
 * @returns {string}
 * @throws {Error}
 */
export function getEndpoint(serverUrl) {
    if (serverUrl.length === 0) {
        throw new Error('Enter the URL of a sync server');
    }
    const url = new URL(serverUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('The sync server URL must start with http:// or https://');
    }
    // Anki adds the methods' paths to the URL, so it has to end with a slash
    if (!url.pathname.endsWith('/')) { url.pathname += '/'; }
    url.search = '';
    url.hash = '';
    return url.href;
}

/**
 * The first field as Anki compares it to find duplicates: after normalizing it, removing HTML except the file
 * names of media, and decoding entities (`strip_html_preserving_media_filenames` in rslib/src/text.rs).
 * @param {string} field
 * @returns {?string} Null if the field is empty, which Anki does not compare.
 */
export function getDuplicateKey(field) {
    const withoutMedia = field.normalize('NFC').replace(HTML_MEDIA_TAGS, (_match, name1, name2, name3) => ` ${name1 ?? ''}${name2 ?? ''}${name3 ?? ''} `);
    const key = decodeEntities(withoutMedia.replace(HTML, ''));
    return key.trim().length > 0 ? key : null;
}

/**
 * Anki compares the first field of the note type, which may not be the note's first one.
 * @param {import('anki').Note} note
 * @param {import('anki-sync').Notetype[]} notetypes
 * @returns {?string}
 */
function getNoteKey(note, notetypes) {
    const modelName = note.modelName.toLowerCase();
    const firstFieldName = notetypes.find(({name}) => name.toLowerCase() === modelName)?.fieldNames[0];
    const firstField = typeof firstFieldName === 'string' ? note.fields[firstFieldName] : Object.values(note.fields)[0];
    return typeof firstField === 'string' ? getDuplicateKey(firstField) : null;
}

/**
 * @param {string} name The deck's name, in lower case.
 * @param {string} scopeName The name of the deck that duplicates are found in, in lower case.
 * @param {boolean} includeChildren
 * @returns {boolean}
 */
function isDeckInScope(name, scopeName, includeChildren) {
    return name === scopeName || (includeChildren && name.startsWith(`${scopeName}::`));
}

/**
 * Anki decodes entities with htmlescape, leaving the text as it is if one cannot be decoded, then replaces
 * non-breaking spaces with spaces.
 * @param {string} text
 * @returns {string}
 */
function decodeEntities(text) {
    if (!text.includes('&')) { return text; }
    let decodable = true;
    const decoded = text.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (/** @type {string} */ match, /** @type {string} */ name) => {
        if (name.startsWith('#')) {
            const codePoint = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.substring(2), 16) : Number.parseInt(name.substring(1), 10);
            if (codePoint <= 0x10ffff) { return String.fromCodePoint(codePoint); }
        } else {
            const value = HTML_ENTITIES.get(name);
            if (typeof value === 'string') { return value; }
        }
        decodable = false;
        return match;
    });
    return decodable ? decoded.replace(/\u00a0/g, ' ') : text;
}
