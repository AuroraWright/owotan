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

import type {DictionaryDatabaseEngine} from '../../ext/js/dictionary/dictionary-database-engine';
import type {SerializedError} from './core';

export type MessageToWorker = (
    Invoke |
    ConnectToDatabaseWorker
);

/** The engine methods the dictionary database calls in the worker. */
export type EngineMethodName = {
    [K in keyof DictionaryDatabaseEngine]: K extends `_${string}` ? never : (DictionaryDatabaseEngine[K] extends (...args: never[]) => Promise<unknown> ? K : never);
}[keyof DictionaryDatabaseEngine];

export type InvokeParams = {
    id: number;
    name: EngineMethodName;
    args: unknown[];
};

export type Invoke = {
    action: 'invoke';
    params: InvokeParams;
};

export type ConnectToDatabaseWorker = {
    action: 'connectToDatabaseWorker';
    params: null;
};

export type MessageFromWorker = (
    {id: number, result: unknown} |
    {id: number, error: SerializedError}
);
