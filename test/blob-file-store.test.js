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

import {afterAll, beforeAll, describe, expect, test, vi} from 'vitest';
import {BlobReadHandle, setBlockCache, trimBlockCache} from '../ext/js/data/blob-file-store.js';

/** The defaults of `setBlockCache`. */
const DEFAULT_BLOCK_CACHE = {size: 256 * 64 * 1024, blockSize: 64 * 1024, readAheadSize: 128 * 64 * 1024};

/**
 * A Blob whose content `FileReaderSync` reads synchronously, as Node has no `FileReaderSync`.
 */
class TestBlob {
    /**
     * @param {Uint8Array} content
     */
    constructor(content) {
        /** @type {Uint8Array} */
        this.content = content;
    }

    /** @type {number} */
    get size() {
        return this.content.byteLength;
    }

    /**
     * @param {number} start
     * @param {number} end
     * @returns {TestBlob}
     */
    slice(start, end) {
        return new TestBlob(this.content.slice(start, end));
    }
}

/**
 * Joins TestBlobs, as `readBlobs` joins Blobs to read them together.
 */
class TestJoinedBlob extends TestBlob {
    /**
     * @param {TestBlob[]} parts
     */
    constructor(parts) {
        const content = new Uint8Array(parts.reduce((size, part) => size + part.size, 0));
        let position = 0;
        for (const part of parts) {
            content.set(part.content, position);
            position += part.size;
        }
        super(content);
    }
}

/** @type {number} */
let readCount = 0;

class TestFileReaderSync {
    /**
     * @param {TestBlob} blob
     * @returns {ArrayBuffer}
     */
    readAsArrayBuffer(blob) {
        ++readCount;
        return new Uint8Array(blob.content).buffer;
    }
}

/**
 * @param {number} size
 * @param {number} seed
 * @returns {Uint8Array}
 */
function createContent(size, seed) {
    const content = new Uint8Array(size);
    for (let i = 0; i < size; ++i) {
        content[i] = (i * 31 + seed) & 0xff;
    }
    return content;
}

/**
 * @param {Uint8Array} content
 * @returns {BlobReadHandle}
 */
function createHandle(content) {
    return new BlobReadHandle(/** @type {Blob} */ (/** @type {unknown} */ (new TestBlob(content))));
}

describe('BlobReadHandle', () => {
    beforeAll(() => {
        vi.stubGlobal('FileReaderSync', TestFileReaderSync);
        vi.stubGlobal('Blob', TestJoinedBlob);
    });

    afterAll(() => {
        vi.unstubAllGlobals();
    });

    test('Reads what the file holds, within blocks, across them and past its end', () => {
        const contents = [createContent(200_000, 1), createContent(70_000, 2), createContent(10, 3)];
        const handles = contents.map(createHandle);
        let random = 12345;
        const next = (/** @type {number} */ max) => {
            random = (random * 1103515245 + 12345) % 2147483648;
            return random % max;
        };
        for (let i = 0; i < 2000; ++i) {
            const index = next(contents.length);
            const content = contents[index];
            const at = next(content.byteLength + 100);
            const length = [1, 8, 4096, 65535, 65536, 150_000][next(6)];
            const buffer = new Uint8Array(length);
            const count = handles[index].read(buffer, {at});
            const expected = content.subarray(at, Math.min(at + length, content.byteLength));
            expect(count).toStrictEqual(expected.byteLength);
            // Compared as Buffers, as comparing large arrays with toStrictEqual is slow
            expect(Buffer.compare(buffer.subarray(0, count), expected)).toStrictEqual(0);
        }
    });

    test('Reads a large range in parts', () => {
        const content = createContent(20_000_000, 5);
        const handle = createHandle(content);
        const buffer = new Uint8Array(19_000_000);
        readCount = 0;
        expect(handle.read(buffer, {at: 500_000})).toStrictEqual(buffer.byteLength);
        expect(Buffer.compare(buffer, content.subarray(500_000, 19_500_000))).toStrictEqual(0);
        expect(readCount).toStrictEqual(3);
    });

    test('Reads a block once for the small reads in it', () => {
        const handle = createHandle(createContent(200_000, 4));
        readCount = 0;
        for (let at = 0; at < 60_000; at += 100) {
            handle.read(new Uint8Array(16), {at});
        }
        expect(readCount).toStrictEqual(1);
    });

    test('Keeps as many blocks as the cache size set holds', () => {
        const blockSize = 64 * 1024;
        const blockCount = 300;
        const handle = createHandle(createContent(blockCount * blockSize, 6));
        const readBlocks = () => {
            readCount = 0;
            for (let i = 0; i < blockCount; ++i) {
                handle.read(new Uint8Array(16), {at: i * blockSize});
            }
            // As after each request
            trimBlockCache();
            return readCount;
        };
        try {
            setBlockCache({...DEFAULT_BLOCK_CACHE, size: blockCount * blockSize});
            readBlocks();
            expect(readBlocks()).toStrictEqual(0);
            // The least recently used block was dropped
            setBlockCache({...DEFAULT_BLOCK_CACHE, size: (blockCount - 1) * blockSize});
            readBlocks();
            expect(readBlocks()).toStrictEqual(1);
        } finally {
            setBlockCache(DEFAULT_BLOCK_CACHE);
        }
    });

    test('Reads blocks of the size set', () => {
        const blockSize = 8 * 1024;
        const content = createContent(100 * blockSize, 7);
        const handle = createHandle(content);
        try {
            setBlockCache({...DEFAULT_BLOCK_CACHE, blockSize});
            readCount = 0;
            for (let at = 0; at + 200 <= 10 * blockSize; at += 100) {
                const buffer = new Uint8Array(200);
                expect(handle.read(buffer, {at})).toStrictEqual(200);
                expect(Buffer.compare(buffer, content.subarray(at, at + 200))).toStrictEqual(0);
            }
            expect(readCount).toStrictEqual(10);
        } finally {
            setBlockCache(DEFAULT_BLOCK_CACHE);
        }
    });

    test('Reads ahead more than the cache holds, which it keeps until it is trimmed', () => {
        const blockSize = 8 * 1024;
        const blockCount = 100;
        const content = createContent(blockCount * blockSize, 8);
        const handle = createHandle(content);
        try {
            setBlockCache({size: 10 * blockSize, blockSize, readAheadSize: blockCount * blockSize});
            for (let i = 0; i < blockCount; ++i) {
                handle.advise(i * blockSize, 16);
            }
            readCount = 0;
            for (let i = 0; i < blockCount; ++i) {
                const buffer = new Uint8Array(16);
                handle.read(buffer, {at: i * blockSize});
                expect(Buffer.compare(buffer, content.subarray(i * blockSize, i * blockSize + 16))).toStrictEqual(0);
            }
            expect(readCount).toStrictEqual(1);
            trimBlockCache();
            readCount = 0;
            for (let i = 0; i < blockCount; ++i) {
                handle.read(new Uint8Array(16), {at: i * blockSize});
            }
            // Only the 10 most recently read stayed
            expect(readCount).toStrictEqual(blockCount - 10);
        } finally {
            setBlockCache(DEFAULT_BLOCK_CACHE);
        }
    });
});
