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

/** What the server's `meta` method tells about the collection. */
export type Meta = {
    /** When the collection was last changed, in milliseconds. */
    mod: number;
    /** When the collection last needed a full sync, in milliseconds. */
    scm: number;
    /** The number of the next sync. */
    usn: number;
    /** Whether the server allows syncing. */
    cont: boolean;
    msg: string;
};

/** The ids of objects deleted since a sync. */
export type Graves = {
    cards: number[];
    notes: number[];
    decks: number[];
};

export type Notetype = {
    id: number;
    name: string;
    fieldNames: string[];
};

export type Deck = {
    id: number;
    /** The names of the deck and its parents, separated by `::`. */
    name: string;
    filtered: boolean;
};

export type Changes = {
    notetypes: Notetype[];
    decks: Deck[];
};

export type ChunkNote = {
    id: number;
    notetypeId: number;
    fields: string[];
};

export type ChunkCard = {
    id: number;
    noteId: number;
    /** The deck the card belongs to, which is not the filtered deck it may be in. */
    deckId: number;
};

export type Chunk = {
    done: boolean;
    notes: ChunkNote[];
    cards: ChunkCard[];
    reviewCount: number;
};

/** How the copy logs in. */
export type Login = {
    /** The URL of the sync server that the user gave. */
    serverUrl: string;
    /** The URL that requests are sent to, which the server may have redirected to. */
    endpoint: string;
    username: string;
    hostKey: string;
};

/** Which state of the collection the copy has. */
export type SyncState = {
    usn: number;
    scm: number;
    /** When the copy was last made the same as the collection, in milliseconds. */
    updatedAt: number;
};

/** A note added since the copy was updated, which the copy does not have until it is updated after a sync. */
export type PendingNote = {
    key: string;
    modelName: string;
    deckName: string;
    addedAt: number;
};

export type StoredNote = {
    id: number;
    notetypeId: number;
    /** The first field as Anki compares it to find duplicates. */
    key: string;
};

export type StoredCard = {
    id: number;
    noteId: number;
    deckId: number;
};

export type StateRecord =
    {name: 'login', value: Login} |
    {name: 'sync', value: SyncState} |
    {name: 'pending', value: PendingNote[]} |
    {name: 'checkedAt', value: number};

export type Status = {
    serverUrl: string;
    username: string;
    /** When the copy was last made the same as the collection, or null if it has never been. */
    updatedAt: number | null;
    noteCount: number;
};

export type UpdateProgress = {
    noteCount: number;
};

export type CollectionInfo = {
    deckNames: string[];
    models: {name: string, fieldNames: string[]}[];
};
