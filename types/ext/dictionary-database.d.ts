/*
 * Copyright (C) 2023-2026  Yomitan Authors
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

import type * as Dictionary from './dictionary';
import type * as DictionaryData from './dictionary-data';
import type * as DictionaryImporter from './dictionary-importer';
import type {Hoshidicts} from '../../ext/js/dictionary/hoshidicts';

export type MediaDataBase<TContentType = unknown> = {
    dictionary: string;
    path: string;
    mediaType: string;
    width: number;
    height: number;
    content: TContentType;
};

export type MediaDataArrayBufferContent = MediaDataBase<ArrayBuffer>;

export type MediaDataStringContent = MediaDataBase<string>;

type MediaType = ArrayBuffer | string | null;

export type Media<T extends MediaType = ArrayBuffer> = {index: number} & MediaDataBase<T>;

export type DrawMedia<T extends MediaType = ArrayBuffer> = {index: number} & MediaDataBase<T> & {canvasWidth: number, canvasHeight: number, canvasIndexes: number[], generation: number};

export type TermEntry = {
    index: number;
    matchType: MatchType;
    matchSource: MatchSource;
    term: string;
    reading: string;
    definitionTags: string[];
    termTags: string[];
    rules: string[];
    definitions: DictionaryData.TermGlossary[];
    /**
     * Set when the database has not loaded the row's glossary content: `definitions` then holds only
     * the deinflection definitions, and this is the number of other definitions, which
     * `findTermGlossariesBulk` loads.
     */
    deferredDefinitionCount?: number;
    score: number;
    dictionary: string;
    id: number;
    sequence: number;
};

export type KanjiEntry = {
    index: number;
    character: string;
    onyomi: string[];
    kunyomi: string[];
    tags: string[];
    definitions: string[];
    stats: {[name: string]: string};
    dictionary: string;
};

export type Tag = {
    name: string;
    category: string;
    order: number;
    notes: string;
    score: number;
    dictionary: string;
};

export type TermMetaFrequencyDataWithReading = {
    reading: string;
    frequency: DictionaryData.GenericFrequencyData;
};

export type TermMeta = TermMetaFrequency | TermMetaPitch | TermMetaPhoneticData;

export type TermMetaType = TermMeta['mode'];

export type TermMetaFrequency = {
    index: number;
    term: string;
    mode: 'freq';
    data: DictionaryData.GenericFrequencyData | DictionaryData.TermMetaFrequencyDataWithReading;
    dictionary: string;
};

export type TermMetaPitch = {
    mode: 'pitch';
    index: number;
    term: string;
    data: DictionaryData.TermMetaPitchData;
    dictionary: string;
};

export type TermMetaPhoneticData = {
    mode: 'ipa';
    index: number;
    term: string;
    data: DictionaryData.TermMetaPhoneticData;
    dictionary: string;
};

export type KanjiMeta = KanjiMetaFrequency;

export type KanjiMetaType = KanjiMeta['mode'];

export type KanjiMetaFrequency = {
    index: number;
    character: string;
    mode: 'freq';
    data: DictionaryData.GenericFrequencyData;
    dictionary: string;
};

export type DictionaryCounts = {
    total: DictionaryCountGroup | null;
    counts: DictionaryCountGroup[];
};

export type DictionaryCountGroup = {
    [key: string]: number;
};

export type MatchType = Dictionary.TermSourceMatchType;

export type MatchSource = Dictionary.TermSourceMatchSource;

export type DictionaryAndQueryRequest = {
    query: string | number;
    dictionary: string;
};

export type TermExactRequest = {
    term: string;
    reading: string;
};

export type MediaRequest = {
    path: string;
    dictionary: string;
};

export type TermGlossaryRequest = {
    id: number;
    dictionary: string;
};

export type DrawMediaRequest = {
    path: string;
    dictionary: string;
    canvasIndex: number;
    canvasWidth: number;
    canvasHeight: number;
    generation: number;
};

export type DrawMediaGroupedRequest = {
    path: string;
    dictionary: string;
    canvasIndexes: number[];
    canvasWidth: number;
    canvasHeight: number;
    generation: number;
};

/** The dictionaries a query is limited to. */
export type DictionarySet = {
    keys(): Iterable<string>;
};

/** What Yomitan stores with each hoshidicts dictionary. */
export type DictionaryRecord = {
    summary: DictionaryImporter.Summary;
    /** The width and height of each image the dictionary's glossaries show, by path. */
    media: {[path: string]: [width: number, height: number]};
    /** The tag bank rows. */
    tags: TagRecord[];
};

export type TagRecord = DictionaryData.Tag;

export type StoredDictionary = {
    id: string;
    record: DictionaryRecord;
};

export type DictionaryFile = {
    name: string;
    content: Uint8Array;
};

/** Where imported dictionaries are kept. */
export interface DictionaryStorage {
    getDictionaries(): Promise<StoredDictionary[]>;
    /**
     * Prepares a directory at `path` in the file system of `hoshidicts`, calls `write`, which has hoshidicts
     * import a dictionary into it, then stores the files it wrote with the record `write` returns, and
     * returns that record.
     */
    addDictionary(id: string, hoshidicts: Hoshidicts, path: string, write: () => Promise<DictionaryRecord>): Promise<DictionaryRecord>;
    deleteDictionary(id: string): Promise<void>;
    /**
     * Opens what mounting a dictionary needs and returns a function that mounts it at `path` in the
     * engine's file system.
     */
    mount(hoshidicts: Hoshidicts, id: string, path: string): Promise<() => void>;
    unmount(hoshidicts: Hoshidicts, path: string): void;
}

/** A stored dictionary as the engine has it. */
export type EngineDictionary = {
    id: string;
    /** The dictionary's position in import order. */
    index: number;
    record: DictionaryRecord;
    media: Map<string, [width: number, height: number]>;
    tags: Map<string, Tag>;
};

/** API for communicating with its own worker */

import type {
    ApiMap as BaseApiMap,
    ApiMapInit as BaseApiMapInit,
    ApiHandler as BaseApiHandler,
    ApiParams as BaseApiParams,
    ApiReturn as BaseApiReturn,
    ApiNames as BaseApiNames,
    ApiParam as BaseApiParam,
    ApiParamNames as BaseApiParamNames,
    ApiParamsAny as BaseApiParamsAny,
} from './api-map';

type ApiSurface = {
    drawMedia: {
        params: {
            requests: DrawMediaRequest[];
        };
        return: void;
    };
    dummy: {
        params: void;
        return: void;
    };
};

type ApiExtraArgs = [port: MessagePort];

export type ApiNames = BaseApiNames<ApiSurface>;

export type ApiMap = BaseApiMap<ApiSurface, ApiExtraArgs>;

export type ApiMapInit = BaseApiMapInit<ApiSurface, ApiExtraArgs>;

export type ApiHandler<TName extends ApiNames> = BaseApiHandler<ApiSurface[TName], ApiExtraArgs>;

export type ApiHandlerNoExtraArgs<TName extends ApiNames> = BaseApiHandler<ApiSurface[TName], []>;

export type ApiParams<TName extends ApiNames> = BaseApiParams<ApiSurface[TName]>;

export type ApiParam<TName extends ApiNames, TParamName extends BaseApiParamNames<ApiSurface[TName]>> = BaseApiParam<ApiSurface[TName], TParamName>;

export type ApiReturn<TName extends ApiNames> = BaseApiReturn<ApiSurface[TName]>;

export type ApiParamsAny = BaseApiParamsAny<ApiSurface>;

export type ApiMessageAny = {[name in ApiNames]: ApiMessage<name>}[ApiNames];

type ApiMessage<TName extends ApiNames> = {
    action: TName;
    params: ApiParams<TName>;
};
