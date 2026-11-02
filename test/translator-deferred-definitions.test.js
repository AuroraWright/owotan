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

import {readFileSync} from 'fs';
import {fileURLToPath} from 'node:url';
import path from 'path';
import {describe, test} from 'vitest';
import {parseJson} from '../dev/json.js';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';
import {createTranslatorContext} from './fixtures/translator-test.js';
import {setupStubs} from './utilities/database.js';
import {createFindTermsOptions} from './utilities/translator.js';

setupStubs();

/**
 * Leaves every term row's glossary content to `findTermGlossariesBulk`, as a database that defers it does.
 */
class DeferredDefinitionsDatabase extends DictionaryDatabase {
    /** @type {DictionaryDatabase['findTermsBulk']} */
    async findTermsBulk(termList, dictionaries, matchType) {
        return (await super.findTermsBulk(termList, dictionaries, matchType)).map(deferDefinitions);
    }

    /** @type {DictionaryDatabase['findTermsExactBulk']} */
    async findTermsExactBulk(termList, dictionaries) {
        return (await super.findTermsExactBulk(termList, dictionaries)).map(deferDefinitions);
    }

    /** @type {DictionaryDatabase['findTermsBySequenceBulk']} */
    async findTermsBySequenceBulk(items) {
        return (await super.findTermsBySequenceBulk(items)).map(deferDefinitions);
    }
}

/**
 * @param {import('dictionary-database').TermEntry} entry
 * @returns {import('dictionary-database').TermEntry}
 */
function deferDefinitions(entry) {
    const deinflectionDefinitions = entry.definitions.filter((definition) => Array.isArray(definition));
    return {
        ...entry,
        definitions: deinflectionDefinitions,
        deferredDefinitionCount: entry.definitions.length - deinflectionDefinitions.length,
    };
}

const dirname = path.dirname(fileURLToPath(import.meta.url));
const dictionaryName = 'Test Dictionary 2';
const {translator} = await createTranslatorContext(path.join(dirname, 'data/dictionaries/valid-dictionary1'), dictionaryName, DeferredDefinitionsDatabase);

describe('Translator with deferred definitions', () => {
    /** @type {import('test/translator').TranslatorTestInputs} */
    const {optionsPresets, tests} = parseJson(readFileSync(path.join(dirname, 'data/translator-test-inputs.json'), {encoding: 'utf8'}));
    /** @type {import('test/translator').TranslatorTestResults} */
    const expectedResults = parseJson(readFileSync(path.join(dirname, 'data/translator-test-results.json'), {encoding: 'utf8'}));

    const testCases = tests
        .map((data, i) => ({data, expected: expectedResults[i]}))
        .filter(({data}) => data.func === 'findTerms');
    describe.each(testCases)('Test %#: $data.name', ({data, expected}) => {
        test('Matches the results of a database that loads definitions eagerly', async ({expect}) => {
            if (data.func !== 'findTerms') { return; }
            const {mode, text} = data;
            const options = createFindTermsOptions(dictionaryName, optionsPresets, data.options);
            const {dictionaryEntries, originalTextLength} = await translator.findTerms(mode, text, options);
            expect.soft(originalTextLength).toStrictEqual(expected.originalTextLength);
            expect.soft(dictionaryEntries).toStrictEqual(expected.dictionaryEntries);
        });
    });
});
