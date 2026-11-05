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
         * Imports and removes dictionaries where MeCab runs in the extension. The backend's MeCab loads them again.
         * @type {Mecab}
         */
        this._mecab = new Mecab();
        /** @type {HTMLElement} */
        this._dictionaryList = querySelectorNotNull(document, '#mecab-dictionary-list');
        /** @type {HTMLButtonElement} */
        this._importButton = querySelectorNotNull(document, '#mecab-dictionary-import-button');
        /** @type {HTMLInputElement} */
        this._importFileInput = querySelectorNotNull(document, '#mecab-dictionary-import-file');
        /** @type {HTMLElement} */
        this._importResultsContainer = querySelectorNotNull(document, '#mecab-dictionary-import-results');
    }

    /** */
    prepare() {
        this._testButton.addEventListener('click', this._onTestButtonClick.bind(this), false);
        if (this._mecab.hasStoredDictionaries()) {
            this._mecab.setEnabled(true);
            this._importButton.addEventListener('click', () => this._importFileInput.click(), false);
            this._importFileInput.addEventListener('change', this._onImportFileChange.bind(this), false);
            void this._updateDictionaryList();
        }
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
    }

    /** */
    async _onImportFileChange() {
        const file = this._importFileInput.files?.[0];
        this._importFileInput.value = '';
        if (typeof file === 'undefined') { return; }
        this._importButton.disabled = true;
        setStatus(this._importResultsContainer, 'Importing\u2026', false);
        try {
            const name = await this._mecab.importDictionary(await file.arrayBuffer());
            setStatus(this._importResultsContainer, `Imported ${name}`, false);
        } catch (e) {
            setStatus(this._importResultsContainer, toError(e).message, true);
        } finally {
            this._importButton.disabled = false;
        }
        await this._updateDictionaryList();
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
