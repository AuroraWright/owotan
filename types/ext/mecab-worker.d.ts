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

import type * as Hoshidicts from './hoshidicts';

/** The parts of the MeCab module (dev/mecab) the worker uses. */
export type Module = {
    FS: Hoshidicts.FileSystem & {
        mkdirTree(path: string): void;
    };
    /** The file system type of hoshidicts, whose files are read like origin private file system sync access handles. */
    OPFSFS: unknown;
    /** Wraps an exported C function, converting `'string'` arguments and results. */
    cwrap: <T extends (...args: never[]) => unknown>(name: string, returnType: 'string' | 'number' | null, argumentTypes: ('string' | 'number')[]) => T;
};

export type CreateModule = (options?: Record<string, unknown>) => Promise<Module>;

/** A MeCab tagger that has read a dictionary. */
export type Tagger = {
    /** The names of the dictionary's feature fields. */
    fields: string[];
    /** Returns MeCab's output for the text: a line for each token, then `EOS`. */
    parse: (text: string) => string;
    destroy: () => void;
};

/** The messages that the native MeCab component answered, and those for the dictionaries. */
export type Request = {
    action: string;
    params: RequestParams;
    sequence: number;
};

export type RequestParams = {
    text?: string;
    dictionaries?: string[];
    archive?: ArrayBuffer;
    name?: string;
};

/** Passes a port on which the worker answers requests. */
export type ConnectMessage = {
    action: 'connect';
};

export type Response = {
    sequence: number;
    data?: unknown;
    error?: string;
};
