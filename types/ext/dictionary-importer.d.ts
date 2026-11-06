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

import type * as ZipJS from '@zip.js/zip.js';
import type * as Ajv from 'ajv';
import type * as DictionaryData from './dictionary-data';

export type OnProgressCallback = (data: ProgressData) => void;

export type ImportStep = {label: string, callback?: () => void};

export type ImportSteps = ImportStep[];

export type ProgressData = {
    index: number;
    count: number;
    nextStep?: boolean;
};

export type ImportResult = {
    result: Summary | null;
    errors: Error[];
};

export type ImportDetails = {
    yomitanVersion: string;
};

export type Summary = {
    title: string;
    revision: string;
    sequenced: boolean;
    minimumYomitanVersion?: string;
    version: number;
    importDate: number;
    counts?: SummaryCounts;
    styles: string;
    isUpdatable?: boolean;
    indexUrl?: string;
    downloadUrl?: string;
    author?: string;
    url?: string;
    description?: string;
    attribution?: string;
    sourceLanguage?: string;
    targetLanguage?: string;
    frequencyMode?: DictionaryData.FrequencyMode;
    importSuccess?: boolean;
};

export type SummaryDetails = {
    counts: SummaryCounts;
    styles: string;
    yomitanVersion: string;
    importSuccess: boolean;
};

export type SummaryCounts = {
    terms: SummaryItemCount;
    termMeta: SummaryMetaCount;
    kanji: SummaryItemCount;
    kanjiMeta: SummaryMetaCount;
    tagMeta: SummaryItemCount;
    media: SummaryItemCount;
};

export type SummaryItemCount = {
    total: number;
};

export type SummaryMetaCount = {
    [total: string]: number;
    [key: string]: number;
};

export type ArchiveFileMap = Map<string, ZipJS.Entry>;

export type CompiledSchemaValidators = {
    dictionaryIndex: Ajv.ValidateFunction<unknown>;
};
