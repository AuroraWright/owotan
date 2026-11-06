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
import {AnkiMobile} from '../ext/js/comm/anki-mobile.js';

/**
 * @param {Record<string, string>} fields
 * @returns {import('anki').Note}
 */
function createNote(fields) {
    return {
        fields,
        tags: [],
        deckName: 'Mining',
        modelName: 'Mining',
        options: {
            allowDuplicate: true,
            duplicateScope: 'collection',
            duplicateScopeOptions: {deckName: null, checkChildren: false, checkAllModels: false},
        },
    };
}

/**
 * @param {AnkiMobile} ankiMobile
 * @param {Record<string, string>} fields
 * @returns {Record<string, string>}
 */
function getFields(ankiMobile, fields) {
    const url = new URL(ankiMobile.getAddNoteUrl(createNote(fields), false, null));
    /** @type {Record<string, string>} */
    const result = {};
    for (const [key, value] of url.searchParams) {
        if (key.startsWith('fld')) { result[key.substring(3)] = value; }
    }
    return result;
}

describe('AnkiMobile', () => {
    test('sends media alone in a field as data URLs, which AnkiMobile stores as files', async () => {
        const ankiMobile = new AnkiMobile();
        await ankiMobile.storeMediaFile('audio.mp3', 'AAAA');
        await ankiMobile.storeMediaFile('screenshot.png', 'BBBB');
        expect(getFields(ankiMobile, {Audio: '[sound:audio.mp3]', Image: '<img src="screenshot.png">'})).toStrictEqual({
            Audio: 'data:audio/mpeg;base64,AAAA',
            Image: 'data:image/png;base64,BBBB',
        });
    });

    test('keeps images next to other content in the field as data URLs', async () => {
        const ankiMobile = new AnkiMobile();
        await ankiMobile.storeMediaFile('yomitan_dictionary_media_1.svg', 'CCCC');
        const glossary = '<ol><li>to read <a href="yomitan_dictionary_media_1.svg"><img src="yomitan_dictionary_media_1.svg"><span style="--image: url(&quot;yomitan_dictionary_media_1.svg&quot;);"></span></a></li></ol>';
        const dataUrl = 'data:image/svg+xml;base64,CCCC';
        expect(getFields(ankiMobile, {Glossary: glossary})).toStrictEqual({
            Glossary: `<ol><li>to read <a href="${dataUrl}"><img src="${dataUrl}"><span style="--image: url(&quot;${dataUrl}&quot;);"></span></a></li></ol>`,
        });
    });

    test('keeps images alone in a field as images if AnkiMobile does not store their type as files', async () => {
        const ankiMobile = new AnkiMobile();
        await ankiMobile.storeMediaFile('image.svg', 'DDDD');
        await ankiMobile.storeMediaFile('image.bmp', 'EEEE');
        await ankiMobile.storeMediaFile('image.webp', 'FFFF');
        expect(getFields(ankiMobile, {Svg: '<img src="image.svg">', Bmp: '<img src="image.bmp">', Webp: '<img src="image.webp">'})).toStrictEqual({
            Svg: '<img src="data:image/svg+xml;base64,DDDD">',
            Bmp: '<img src="data:image/bmp;base64,EEEE">',
            Webp: 'data:image/webp;base64,FFFF',
        });
    });

    test('rejects audio next to other content', async () => {
        const ankiMobile = new AnkiMobile();
        await ankiMobile.storeMediaFile('audio.mp3', 'AAAA');
        expect(() => getFields(ankiMobile, {Audio: 'to read [sound:audio.mp3]'})).toThrow();
    });
});
