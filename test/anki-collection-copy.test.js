/*
 * Copyright (C) 2026  Yomitan Authors
 * Copyright (C) 2020-2022  Yomichan Authors
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
import {getDuplicateKey, getEndpoint} from '../ext/js/data/anki-collection-copy.js';

describe('AnkiCollectionCopy', () => {
    describe('getDuplicateKey', () => {
        /** @type {[field: string, expected: ?string][]} */
        const data = [
            ['読む', '読む'],
            ['<b>読む</b>', '読む'],
            ['<span style="color: red">読<br>む</span>', '読む'],
            ['読む&nbsp;', '読む '],
            ['&lt;読む&gt; &amp; &#x8aad;&#12416;', '<読む> & 読む'],
            ['&unknown; 読む', '&unknown; 読む'],
            ['<img src="image.png">', ' image.png '],
            ['<img src=\'image one.png\'>', ' image one.png '],
            ['<img alt="x" src=image.png>', ' image.png '],
            ['<!-- comment -->読む<style>b {}</style><script>x()</script>', '読む'],
            // Decomposed characters are composed, as Anki does when it saves a note
            ['が', 'が'],
            ['', null],
            [' <br> ', null],
            ['&nbsp;', null],
        ];
        test.each(data)('%s', (field, expected) => {
            expect(getDuplicateKey(field)).toStrictEqual(expected);
        });
    });

    describe('getEndpoint', () => {
        /** @type {[serverUrl: string, expected: string][]} */
        const data = [
            ['http://192.168.1.2:8080', 'http://192.168.1.2:8080/'],
            ['https://example.com/anki', 'https://example.com/anki/'],
            ['https://example.com/anki/?a=1#b', 'https://example.com/anki/'],
        ];
        test.each(data)('%s', (serverUrl, expected) => {
            expect(getEndpoint(serverUrl)).toStrictEqual(expected);
        });

        test('rejects other protocols', () => {
            expect(() => getEndpoint('')).toThrow();
            expect(() => getEndpoint('ftp://example.com/')).toThrow();
            expect(() => getEndpoint('not a url')).toThrow();
        });
    });
});
