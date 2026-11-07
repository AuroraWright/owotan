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

import {describe, expect, test} from 'vitest';
import {AnkiNoteBuilder} from '../ext/js/data/anki-note-builder.js';

/**
 * A template renderer that renders a marker as the marker and the dictionary entry's term, and keeps what it was
 * asked to render.
 */
class TestTemplateRenderer {
    constructor() {
        /** @type {string[][]} */
        this.renderedMarkers = [];
    }

    /**
     * @param {import('template-renderer').RenderMultiItem[]} items
     * @returns {Promise<import('core').Response<import('template-renderer').RenderResult>[]>}
     */
    async renderMulti(items) {
        /** @type {import('core').Response<import('template-renderer').RenderResult>[]} */
        const responses = [];
        /** @type {string[]} */
        const markers = [];
        for (const {templateItems} of items) {
            for (const {commonData, datas} of templateItems) {
                const {term} = /** @type {import('dictionary').TermDictionaryEntry} */ (commonData.dictionaryEntry).headwords[0];
                for (const {marker} of datas) {
                    markers.push(`${marker}:${term}`);
                    responses.push({result: {result: `${marker}:${term}`, requirements: []}});
                }
            }
        }
        this.renderedMarkers.push(markers);
        return responses;
    }
}

/**
 * @param {string} term
 * @returns {import('dictionary').DictionaryEntry}
 */
function createDictionaryEntry(term) {
    return /** @type {import('dictionary').DictionaryEntry} */ (/** @type {unknown} */ ({type: 'term', headwords: [{term}]}));
}

/**
 * @param {string} name
 * @param {string[]} markers
 * @returns {import('settings').AnkiCardFormat}
 */
function createCardFormat(name, markers) {
    /** @type {import('settings').AnkiFields} */
    const fields = {};
    for (const marker of markers) {
        fields[marker] = {value: `{${marker}}`, overwriteMode: 'coalesce'};
    }
    return {type: 'term', name, deck: 'deck', model: 'model', fields, icon: 'big-circle'};
}

/**
 * @param {import('dictionary').DictionaryEntry} dictionaryEntry
 * @param {import('settings').AnkiCardFormat} cardFormat
 * @param {Map<string, string>} dictionaryStylesMap
 * @returns {import('anki-note-builder').CreateNoteDetails}
 */
function createNoteDetails(dictionaryEntry, cardFormat, dictionaryStylesMap) {
    return {
        dictionaryEntry,
        cardFormat,
        context: {url: '', sentence: {text: '', offset: 0}, documentTitle: '', query: '', fullQuery: ''},
        template: 'template',
        tags: [],
        requirements: [],
        duplicateScope: 'collection',
        duplicateScopeCheckAllModels: false,
        resultOutputMode: 'group',
        glossaryLayoutMode: 'default',
        compactTags: false,
        mediaOptions: null,
        dictionaryStylesMap,
    };
}

describe('AnkiNoteBuilder', () => {
    test('Renders a marker once for the card formats of a dictionary entry', async () => {
        const templateRenderer = new TestTemplateRenderer();
        const api = /** @type {import('anki-note-builder').MinimalApi} */ (/** @type {unknown} */ ({}));
        const ankiNoteBuilder = new AnkiNoteBuilder(api, /** @type {import('../ext/js/templates/template-renderer.js').TemplateRenderer} */ (/** @type {unknown} */ (templateRenderer)));
        /** @type {Map<string, string>} */
        const dictionaryStylesMap = new Map();
        const entry1 = createDictionaryEntry('term1');
        const entry2 = createDictionaryEntry('term2');
        const cardFormat1 = createCardFormat('format1', ['expression', 'glossary']);
        const cardFormat2 = createCardFormat('format2', ['expression', 'reading']);
        const createNote = (/** @type {import('dictionary').DictionaryEntry} */ dictionaryEntry, /** @type {import('settings').AnkiCardFormat} */ cardFormat) => {
            const details = createNoteDetails(dictionaryEntry, cardFormat, dictionaryStylesMap);
            // The same context, as for the notes of one lookup
            details.context = context;
            return ankiNoteBuilder.createNote(details);
        };
        const {context} = createNoteDetails(createDictionaryEntry(''), createCardFormat('', []), dictionaryStylesMap);

        const notes = await Promise.all([
            createNote(entry1, cardFormat1),
            createNote(entry1, cardFormat2),
            createNote(entry2, cardFormat1),
            createNote(entry2, cardFormat2),
        ]);

        expect(notes.map(({note}) => note.fields)).toStrictEqual([
            {expression: 'expression:term1', glossary: 'glossary:term1'},
            {expression: 'expression:term1', reading: 'reading:term1'},
            {expression: 'expression:term2', glossary: 'glossary:term2'},
            {expression: 'expression:term2', reading: 'reading:term2'},
        ]);
        expect(templateRenderer.renderedMarkers).toStrictEqual([[
            'expression:term1',
            'glossary:term1',
            'reading:term1',
            'expression:term2',
            'glossary:term2',
            'reading:term2',
        ]]);
    });

    test('Renders separately for different contexts', async () => {
        const templateRenderer = new TestTemplateRenderer();
        const api = /** @type {import('anki-note-builder').MinimalApi} */ (/** @type {unknown} */ ({}));
        const ankiNoteBuilder = new AnkiNoteBuilder(api, /** @type {import('../ext/js/templates/template-renderer.js').TemplateRenderer} */ (/** @type {unknown} */ (templateRenderer)));
        const dictionaryEntry = createDictionaryEntry('term');
        const cardFormat = createCardFormat('format', ['expression']);
        /** @type {Map<string, string>} */
        const dictionaryStylesMap = new Map();
        const createNote = () => ankiNoteBuilder.createNote(createNoteDetails(dictionaryEntry, cardFormat, dictionaryStylesMap));

        await Promise.all([createNote(), createNote()]);

        expect(templateRenderer.renderedMarkers).toStrictEqual([['expression:term', 'expression:term']]);
    });
});
