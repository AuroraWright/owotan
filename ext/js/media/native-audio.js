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

import {log} from '../core/log.js';
import {generateId} from '../core/utilities.js';
import {arrayBufferToBase64} from '../data/array-buffer-util.js';

/**
 * Audio that the app extension holding this one plays, in Safari. Safari plays audio in a page only after a gesture
 * in that page has started audio, which a popup opened by hovering never gets, so the page cannot play it itself.
 * The app extension plays one audio at a time, so playing audio stops the audio that plays.
 */
export class NativeAudio {
    /**
     * @param {import('../comm/api.js').API} api
     * @param {() => Promise<string>} getData Gets the audio, encoded with base64.
     */
    constructor(api, getData) {
        /** @type {import('../comm/api.js').API} */
        this._api = api;
        /** @type {() => Promise<string>} */
        this._getData = getData;
        /** @type {?Promise<string>} */
        this._data = null;
        /**
         * Identifies the audio while it plays.
         * @type {?string}
         */
        this._id = null;
        /**
         * Audio always plays from the start; this is set for the interface of an audio element.
         * @type {number}
         */
        this.currentTime = 0;
        /** @type {number} */
        this.volume = 1;
    }

    /**
     * @param {import('../comm/api.js').API} api
     * @param {string} data The audio, encoded with base64.
     * @returns {NativeAudio}
     */
    static fromData(api, data) {
        return new NativeAudio(api, () => Promise.resolve(data));
    }

    /**
     * @param {import('../comm/api.js').API} api
     * @param {string} url The URL of a file of the extension.
     * @returns {NativeAudio}
     */
    static fromUrl(api, url) {
        return new NativeAudio(api, async () => {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`Could not load ${url}`);
            }
            return arrayBufferToBase64(await response.arrayBuffer());
        });
    }

    /**
     * Starts playing the audio, once it has been loaded.
     * @returns {Promise<void>}
     */
    async play() {
        const id = generateId(16);
        this._id = id;
        if (this._data === null) {
            this._data = this._getData();
        }
        let data;
        try {
            data = await this._data;
        } catch (e) {
            this._data = null; // Loaded again when played again
            throw e;
        }
        if (this._id !== id) { return; } // Paused while loading
        // The app extension answers once the audio has stopped, so this does not wait for it.
        this._api.playNativeAudio(id, data, this.volume).catch((e) => {
            log.error(e);
        });
    }

    /** */
    pause() {
        if (this._id === null) { return; }
        void this._api.stopNativeAudio(this._id);
        this._id = null;
    }
}
