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

/** 20 ms of silence, played to unlock the element. */
const SILENT_AUDIO_URL = 'data:audio/wav;base64,UklGRsQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YaAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA';

/**
 * Plays audio in Safari, where an audio element plays nothing unless a gesture starts it, and on iOS loads nothing
 * either. An element that has been played during a gesture once can play later without one, even with another source,
 * so all audio is played on one element, which `unlock` plays during a gesture.
 */
export class SharedAudioElement {
    constructor() {
        /** @type {HTMLAudioElement} */
        this._element = new Audio();
        /** @type {boolean} */
        this._unlocked = false;
        /** @type {?SharedElementAudio} */
        this._current = null;
    }

    /**
     * Lets the element play without a gesture, if it is called while a gesture is handled.
     */
    unlock() {
        if (this._unlocked) { return; }
        const element = this._element;
        if (!element.paused) {
            // Audio only plays once the element has been unlocked.
            this._unlocked = true;
            return;
        }
        this._current = null;
        element.src = SILENT_AUDIO_URL;
        element.play().then(
            () => { this._unlocked = true; },
            () => {}, // Not called during a gesture
        );
    }

    /**
     * @param {string} url
     * @returns {SharedElementAudio}
     */
    createAudio(url) {
        return new SharedElementAudio(this, url);
    }

    /**
     * @param {SharedElementAudio} audio
     * @returns {Promise<void>}
     */
    play(audio) {
        const element = this._element;
        this._current = audio;
        element.src = audio.url;
        element.currentTime = audio.currentTime;
        element.volume = audio.volume;
        return element.play();
    }

    /**
     * @param {SharedElementAudio} audio
     */
    pause(audio) {
        if (this._current !== audio) { return; }
        this._current = null;
        this._element.pause();
    }
}

/**
 * Audio played on a `SharedAudioElement`.
 */
export class SharedElementAudio {
    /**
     * @param {SharedAudioElement} sharedElement
     * @param {string} url
     */
    constructor(sharedElement, url) {
        /** @type {SharedAudioElement} */
        this._sharedElement = sharedElement;
        /** @type {string} */
        this._url = url;
        /** @type {number} */
        this.currentTime = 0;
        /** @type {number} */
        this.volume = 1;
    }

    /** @type {string} */
    get url() {
        return this._url;
    }

    /**
     * @returns {Promise<void>}
     */
    play() {
        return this._sharedElement.play(this);
    }

    /** */
    pause() {
        this._sharedElement.pause(this);
    }
}
