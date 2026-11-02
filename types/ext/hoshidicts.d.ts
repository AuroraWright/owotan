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

/** The parts of Emscripten's file system the dictionary code uses. */
export type FileSystem = {
    mkdir(path: string): void;
    rmdir(path: string): void;
    readdir(path: string): string[];
    readFile(path: string): Uint8Array;
    writeFile(path: string, data: Uint8Array): void;
    unlink(path: string): void;
    analyzePath(path: string): {exists: boolean};
    isDir(mode: number): boolean;
    stat(path: string): {mode: number, size: number};
    mount(type: unknown, options: unknown, mountPoint: string): void;
    unmount(mountPoint: string): void;
};

export type Module = {
    FS: FileSystem;
    /** Emscripten's file system type for files that are origin private file system sync access handles. */
    OPFSFS: unknown;
    HEAPU8: Uint8Array;
    /** Wraps an exported C function, converting `'string'` arguments and results. */
    cwrap: <T extends (...args: never[]) => unknown>(name: string, returnType: 'string' | 'number' | null, argumentTypes: ('string' | 'number')[]) => T;
};

export type CreateModule = (options?: Record<string, unknown>) => Promise<Module>;

export type ImportReport = {
    success: boolean;
    title: string;
    /** The directory the dictionary was written to. */
    directory: string;
    error: string;
};

export type TermRedirect = {
    form_of: string;
    rules: string[];
};

export type TermRow = {
    dict_name: string;
    expression: string;
    reading: string;
    definition_tags: string;
    rules: string;
    term_tags: string;
    score: number;
    redirects: TermRedirect[];
    /** The number of glossary items other than redirects. */
    content_count: number;
    sequence: number;
    /** Identifies the row within its dictionary. */
    offset: number;
    /** Whether the key matched the reading rather than the expression. */
    reading_match: boolean;
};

export type MetaRow = {
    dict_name: string;
    expression: string;
    mode: string;
    /** JSON. */
    data: string;
};

export type KanjiRow = {
    dict_name: string;
    character: string;
    onyomi: string;
    kunyomi: string;
    tags: string;
    meanings: string[];
    stats: {[name: string]: string};
};

export type ErrorResult = {
    error: string;
};
