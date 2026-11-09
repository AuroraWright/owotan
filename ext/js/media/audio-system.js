/*
 * Copyright (C) 2023-2026  Yomitan Authors
 * Copyright (C) 2019-2022  Yomichan Authors
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

import {API} from '../comm/api.js';
import {EventDispatcher} from '../core/event-dispatcher.js';
import {isLocalNetworkUrl} from '../core/utilities.js';
import {NativeAudio} from './native-audio.js';
import {TextToSpeechAudio} from './text-to-speech-audio.js';

/** @typedef {HTMLAudioElement|NativeAudio|import('./shared-audio-element.js').SharedElementAudio} AudioElement */

/**
 * @augments EventDispatcher<import('audio-system').Events>
 */
export class AudioSystem extends EventDispatcher {
    /**
     * @param {API?} api
     * @param {boolean} nativeAudio Whether the app extension plays audio from URLs, in Safari, for which audio is then
     *   downloaded with the API.
     * @param {?import('./shared-audio-element.js').SharedAudioElement} [sharedAudioElement] The element to play audio
     *   from URLs on, in Safari builds where the app extension does not play audio, which then download audio with the
     *   API.
     */
    constructor(api, nativeAudio, sharedAudioElement = null) {
        super();
        /** @type {?AudioElement} */
        this._fallbackAudio = null;
        /** @type {?import('settings').FallbackSoundType} */
        this._fallbackSoundType = null;
        /** @type {API?} */
        this._api = api;
        /** @type {boolean} */
        this._nativeAudio = nativeAudio;
        /** @type {?import('./shared-audio-element.js').SharedAudioElement} */
        this._sharedAudioElement = sharedAudioElement;
    }

    /**
     * @returns {void}
     */
    prepare() {
        // speechSynthesis.getVoices() will not be populated unless some API call is made.
        if (
            typeof speechSynthesis !== 'undefined' &&
            typeof speechSynthesis.addEventListener === 'function'
        ) {
            speechSynthesis.addEventListener('voiceschanged', this._onVoicesChanged.bind(this), false);
        }
    }

    /**
     * @param {import('settings').FallbackSoundType} fallbackSoundType
     * @returns {AudioElement}
     */
    getFallbackAudio(fallbackSoundType) {
        if (this._fallbackAudio === null || this._fallbackSoundType !== fallbackSoundType) {
            this._fallbackSoundType = fallbackSoundType;
            switch (fallbackSoundType) {
                case 'click':
                    this._fallbackAudio = this._createAudioElement('/data/audio/fallback-click.mp3');
                    break;
                case 'bloop':
                    this._fallbackAudio = this._createAudioElement('/data/audio/fallback-bloop.mp3');
                    break;
                case 'none':
                    // audio handler expects audio url to always be present, empty string must be used instead of `new Audio()`
                    this._fallbackAudio = new Audio('');
                    break;
            }
        }
        return this._fallbackAudio;
    }

    /**
     * @param {string} url
     * @param {import('settings').AudioSourceType} sourceType
     * @returns {Promise<AudioElement>}
     */
    async createAudio(url, sourceType) {
        if (this._nativeAudio && this._api !== null) {
            // The audio is checked as it is downloaded, as the app extension only gets it to play.
            const {data} = await this._api.downloadAudio(url, sourceType);
            return NativeAudio.fromData(this._api, data);
        }
        if (this._sharedAudioElement !== null && this._api !== null) {
            // The shared element cannot load audio before it plays, so the audio is downloaded and checked here.
            const {data, contentType} = await this._api.downloadAudio(url, sourceType);
            return this._sharedAudioElement.createAudio(`data:${contentType ?? 'audio/mpeg'};base64,${data}`);
        }

        // Audio on this device or its local network is downloaded by the background page and played from its data,
        // as Chrome asks for local network access for an audio element's request but not for the background page's.
        if (isLocalNetworkUrl(url) && this._api !== null) {
            const {data, contentType} = await this._api.downloadAudio(url, sourceType);
            url = `data:${contentType ?? 'audio/mpeg'};base64,${data}`;
        }

        const audio = new Audio(url);
        await this._waitForData(audio);
        if (!this._isAudioValid(audio, sourceType)) {
            throw new Error('Could not retrieve audio');
        }
        return audio;
    }

    /**
     * @param {string} text
     * @param {string} voiceUri
     * @returns {TextToSpeechAudio}
     * @throws {Error}
     */
    createTextToSpeechAudio(text, voiceUri) {
        const voice = this._getTextToSpeechVoiceFromVoiceUri(voiceUri);
        if (voice === null) {
            throw new Error('Invalid text-to-speech voice');
        }
        return new TextToSpeechAudio(text, voice);
    }

    // Private

    /**
     * @param {string} url
     * @returns {AudioElement}
     */
    _createAudioElement(url) {
        if (this._nativeAudio && this._api !== null) {
            return NativeAudio.fromUrl(this._api, url);
        }
        return this._sharedAudioElement !== null ? this._sharedAudioElement.createAudio(url) : new Audio(url);
    }

    /**
     * @param {Event} event
     */
    _onVoicesChanged(event) {
        this.trigger('voiceschanged', event);
    }

    /**
     * @param {HTMLAudioElement} audio
     * @returns {Promise<void>}
     */
    _waitForData(audio) {
        return new Promise((resolve, reject) => {
            audio.addEventListener('loadeddata', () => resolve());
            audio.addEventListener('error', () => reject(audio.error));
        });
    }

    /**
     * @param {HTMLAudioElement} audio
     * @param {import('settings').AudioSourceType} sourceType
     * @returns {boolean}
     */
    _isAudioValid(audio, sourceType) {
        switch (sourceType) {
            case 'jpod101':
            {
                const duration = audio.duration;
                return (
                    duration !== 5.694694 && // Invalid audio (Chrome)
                    duration !== 5.651111 // Invalid audio (Firefox)
                );
            }
            default:
                return true;
        }
    }

    /**
     * @param {string} voiceUri
     * @returns {?SpeechSynthesisVoice}
     */
    _getTextToSpeechVoiceFromVoiceUri(voiceUri) {
        try {
            for (const voice of speechSynthesis.getVoices()) {
                if (voice.voiceURI === voiceUri) {
                    return voice;
                }
            }
        } catch (e) {
            // NOP
        }
        return null;
    }
}
