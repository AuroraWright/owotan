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

import {EventListenerCollection} from '../core/event-listener-collection.js';

/** How long to wait for a suspended audio context to start, in milliseconds. */
const RESUME_TIMEOUT = 1000;

export class WebAudioLocalAudio {
    /**
     * @param {string} base64Data
     * @param {string} contentType
     */
    constructor(base64Data, contentType) {
        /** @type {string} */
        this._base64Data = base64Data;
        /** @type {string} */
        this._contentType = contentType;
        /** @type {number} */
        this._volume = 1;
        /** @type {number} */
        this._currentTime = 0;
        /** @type {AudioContext} */
        this._audioContext = new AudioContext();
        /** @type {?AudioBufferSourceNode} */
        this._bufferSource = null;
        /** @type {?GainNode} */
        this._gainNode = null;
        /** @type {?AudioBuffer} */
        this._decodedBuffer = null;

        /** @type {EventListenerCollection} */
        this._bufferSourceEventListeners = new EventListenerCollection();
    }

    /** @type {number} */
    get currentTime() { return this._currentTime; }

    set currentTime(value) { this._currentTime = value; }

    /** @type {number} */
    get volume() { return this._volume; }

    set volume(value) {
        this._volume = value;
        if (this._gainNode) { this._gainNode.gain.value = value; }
    }

    /** @type {number} */
    get duration() { return this._decodedBuffer ? this._decodedBuffer.duration : 0; }

    /** */
    async prepare() {
        const byteCharacters = atob(this._base64Data);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
            byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);

        this._decodedBuffer = await this._audioContext.decodeAudioData(byteArray.buffer);
    }

    /**
     * @returns {Promise<void>}
     */
    async play() {
        if (!this._decodedBuffer || !this._audioContext) { return; }
        this._bufferSourceEventListeners.removeAllEventListeners();

        if (this._audioContext.state === 'closed') {
            this._audioContext = new AudioContext();
        }
        if (this._audioContext.state === 'suspended') {
            await this._resumeAudioContext();
        }

        this._bufferSource = this._audioContext.createBufferSource();
        this._bufferSource.buffer = this._decodedBuffer;

        this._gainNode = this._audioContext.createGain();
        this._gainNode.gain.value = this._volume;

        this._bufferSource.connect(this._gainNode);
        this._gainNode.connect(this._audioContext.destination);
        this._bufferSource.start(0, this._currentTime);

        this._bufferSourceEventListeners.addEventListener(this._bufferSource, 'ended', () => {
            void this._audioContext.close();
        });
    }

    /**
     * Chrome leaves `resume()` pending until the page gets a user gesture when autoplay is not allowed,
     * so playback is given up on after a short wait and fails like an audio element's `play()` does.
     * @throws {DOMException}
     */
    async _resumeAudioContext() {
        const audioContext = this._audioContext;
        /** @type {?import('core').Timeout} */
        let timer = null;
        try {
            await Promise.race([
                audioContext.resume(),
                new Promise((resolve) => { timer = setTimeout(resolve, RESUME_TIMEOUT); }),
            ]);
        } finally {
            if (timer !== null) { clearTimeout(timer); }
        }
        if (audioContext.state !== 'running') {
            // Closed so that a later gesture does not start it; play() creates a new context.
            void audioContext.close();
            throw new DOMException('The audio context was not allowed to start', 'NotAllowedError');
        }
    }

    /**
     * @returns {void}
     */
    pause() {
        if (this._bufferSource) {
            try { this._bufferSource.stop(); } catch (e) { /* NOP */ }
            this._bufferSource = null;
        }
    }
}
