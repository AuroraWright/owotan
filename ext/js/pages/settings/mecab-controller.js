/*
 * Copyright (C) 2023-2026  Yomitan Authors
 * Copyright (C) 2021-2022  Yomichan Authors
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

import {Mecab} from '../../comm/mecab.js';
import {toError} from '../../core/to-error.js';
import {querySelectorNotNull} from '../../dom/query-selector.js';

export class MecabController {
    /**
     * @param {import('../../comm/api.js').API} api
     */
    constructor(api) {
        /** @type {import('../../comm/api.js').API} */
        this._api = api;
        /** @type {HTMLButtonElement} */
        this._testButton = querySelectorNotNull(document, '#test-mecab-button');
        /** @type {HTMLElement} */
        this._resultsContainer = querySelectorNotNull(document, '#test-mecab-results');
        /** @type {boolean} */
        this._testActive = false;
        /**
         * Imports and removes dictionaries. The backend's MeCab loads them again.
         * @type {Mecab}
         */
        this._mecab = new Mecab();
        /** @type {HTMLElement} */
        this._dictionaryList = querySelectorNotNull(document, '#mecab-dictionary-list');
        /**
         * Download the dictionaries that the native component's installer offers, from the same archives.
         * @type {HTMLButtonElement[]}
         */
        this._downloadButtons = [...document.querySelectorAll('button.mecab-dictionary-download-button')].map((element) => /** @type {HTMLButtonElement} */ (element));
        /** @type {HTMLElement} */
        this._importResultsContainer = querySelectorNotNull(document, '#mecab-dictionary-import-results');
    }

    /** */
    prepare() {
        this._testButton.addEventListener('click', this._onTestButtonClick.bind(this), false);
        this._mecab.setEnabled(true);
        for (const button of this._downloadButtons) {
            button.addEventListener('click', () => { void this._downloadDictionary(button); }, false);
        }
        void this._updateDictionaryList();
    }

    // Private

    /** */
    async _updateDictionaryList() {
        /** @type {string[]} */
        let names = [];
        try {
            names = await this._mecab.getDictionaries();
        } catch (e) {
            setStatus(this._importResultsContainer, toError(e).message, true);
        }
        const fragment = document.createDocumentFragment();
        if (names.length === 0) {
            const item = document.createElement('p');
            item.textContent = 'No dictionary has been imported.';
            fragment.appendChild(item);
        }
        for (const name of names) {
            const item = document.createElement('div');
            item.className = 'margin-above flex-row-nowrap';
            const label = document.createElement('span');
            label.textContent = name;
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'low-emphasis flex-margin-left';
            button.textContent = 'Remove';
            button.addEventListener('click', () => { void this._deleteDictionary(name); }, false);
            item.append(label, button);
            fragment.appendChild(item);
        }
        this._dictionaryList.replaceChildren(fragment);
        for (const button of this._downloadButtons) {
            button.hidden = names.includes(button.dataset.dictionary ?? '');
        }
    }

    /**
     * @param {HTMLButtonElement} button
     */
    async _downloadDictionary(button) {
        const url = button.dataset.url;
        if (typeof url !== 'string') { return; }
        this._setDownloadButtonsDisabled(true);
        try {
            setStatus(this._importResultsContainer, 'Downloading\u2026', false);
            let response;
            try {
                response = await fetch(url, {credentials: 'omit', redirect: 'follow', referrerPolicy: 'no-referrer'});
            } catch (e) {
                throw new Error(`Could not download the dictionary: ${toError(e).message}`);
            }
            if (!response.ok) {
                throw new Error(`Could not download the dictionary: ${response.status}`);
            }
            const archive = await this._readDownload(response);
            setStatus(this._importResultsContainer, 'Importing\u2026', false);
            const name = await this._mecab.importDictionary(archive);
            setStatus(this._importResultsContainer, `Imported ${name}`, false);
        } catch (e) {
            setStatus(this._importResultsContainer, toError(e).message, true);
        } finally {
            this._setDownloadButtonsDisabled(false);
        }
        await this._updateDictionaryList();
    }

    /**
     * Reads a download, showing how much of it has arrived.
     * @param {Response} response
     * @returns {Promise<ArrayBuffer>}
     */
    async _readDownload(response) {
        const total = Number(response.headers.get('Content-Length'));
        const reader = response.body !== null ? response.body.getReader() : null;
        if (reader === null || !Number.isFinite(total) || total <= 0) {
            return await response.arrayBuffer();
        }
        /** @type {Uint8Array[]} */
        const chunks = [];
        let loaded = 0;
        let percent = 0;
        while (true) {
            const {done, value} = await reader.read();
            if (done) { break; }
            chunks.push(value);
            loaded += value.byteLength;
            const percent2 = Math.min(100, Math.floor(loaded / total * 100));
            if (percent2 !== percent) {
                percent = percent2;
                setStatus(this._importResultsContainer, `Downloading\u2026 ${percent}%`, false);
            }
        }
        return await new Blob(chunks).arrayBuffer();
    }

    /**
     * @param {boolean} disabled
     */
    _setDownloadButtonsDisabled(disabled) {
        for (const button of this._downloadButtons) {
            button.disabled = disabled;
        }
    }

    /**
     * @param {string} name
     */
    async _deleteDictionary(name) {
        try {
            await this._mecab.deleteDictionary(name);
            this._importResultsContainer.hidden = true;
        } catch (e) {
            setStatus(this._importResultsContainer, toError(e).message, true);
        }
        await this._updateDictionaryList();
    }

    /**
     * @param {MouseEvent} e
     */
    _onTestButtonClick(e) {
        e.preventDefault();
        void this._testMecab();
    }

    /** */
    async _testMecab() {
        if (this._testActive) { return; }

        try {
            this._testActive = true;
            const resultsContainer = /** @type {HTMLElement} */ (this._resultsContainer);
            /** @type {HTMLButtonElement} */ (this._testButton).disabled = true;
            resultsContainer.textContent = '';
            resultsContainer.hidden = true;
            await this._api.testMecab();
            this._setStatus('Connection was successful', false);
        } catch (e) {
            this._setStatus(toError(e).message, true);
        } finally {
            this._testActive = false;
            /** @type {HTMLButtonElement} */ (this._testButton).disabled = false;
        }
    }

    /**
     * @param {string} message
     * @param {boolean} isError
     */
    _setStatus(message, isError) {
        setStatus(/** @type {HTMLElement} */ (this._resultsContainer), message, isError);
    }
}

/**
 * @param {HTMLElement} container
 * @param {string} message
 * @param {boolean} isError
 */
function setStatus(container, message, isError) {
    container.textContent = message;
    container.hidden = false;
    container.classList.toggle('danger-text', isError);
}
