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

import {getAnkiPlatformName} from '../../comm/anki-sync-client.js';
import {toError} from '../../core/to-error.js';
import {AnkiCollectionCopy, getEndpoint} from '../../data/anki-collection-copy.js';

/**
 * Logs in to a sync server, and updates the copy of the collection that AnkiMobile uses.
 * The page does it itself rather than the background page, which iOS may stop while it takes long.
 */
export class AnkiSyncController {
    /**
     * @param {import('./settings-controller.js').SettingsController} settingsController
     * @param {import('./anki-controller.js').AnkiController} ankiController
     */
    constructor(settingsController, ankiController) {
        /** @type {import('./settings-controller.js').SettingsController} */
        this._settingsController = settingsController;
        /** @type {import('./anki-controller.js').AnkiController} */
        this._ankiController = ankiController;
        /** @type {?AnkiCollectionCopy} */
        this._copy = null;
        /** @type {boolean} */
        this._busy = false;
        /** @type {?HTMLElement} */
        this._statusNode = null;
        /** @type {?HTMLButtonElement} */
        this._updateButton = null;
        /** @type {?HTMLButtonElement} */
        this._logoutButton = null;
        /** @type {?HTMLElement} */
        this._loginContainer = null;
        /** @type {?HTMLButtonElement} */
        this._loginButton = null;
        /** @type {?HTMLInputElement} */
        this._serverInput = null;
        /** @type {?HTMLInputElement} */
        this._usernameInput = null;
        /** @type {?HTMLInputElement} */
        this._passwordInput = null;
    }

    /** */
    async prepare() {
        const {platform} = await this._settingsController.application.api.getEnvironmentInfo();
        this._copy = new AnkiCollectionCopy(getAnkiPlatformName(platform.os));
        this._statusNode = /** @type {HTMLElement} */ (document.querySelector('#anki-sync-status'));
        this._updateButton = /** @type {HTMLButtonElement} */ (document.querySelector('#anki-sync-update-button'));
        this._logoutButton = /** @type {HTMLButtonElement} */ (document.querySelector('#anki-sync-logout-button'));
        this._loginContainer = /** @type {HTMLElement} */ (document.querySelector('#anki-sync-login'));
        this._loginButton = /** @type {HTMLButtonElement} */ (document.querySelector('#anki-sync-login-button'));
        this._serverInput = /** @type {HTMLInputElement} */ (document.querySelector('#anki-sync-server-input'));
        this._usernameInput = /** @type {HTMLInputElement} */ (document.querySelector('#anki-sync-username-input'));
        this._passwordInput = /** @type {HTMLInputElement} */ (document.querySelector('#anki-sync-password-input'));
        const loginForm = /** @type {HTMLFormElement} */ (document.querySelector('#anki-sync-login-form'));

        loginForm.addEventListener('submit', this._onLoginFormSubmit.bind(this), false);
        this._updateButton.addEventListener('click', this._onUpdateButtonClick.bind(this), false);
        this._logoutButton.addEventListener('click', this._onLogoutButtonClick.bind(this), false);

        await this._updateStatus();
    }

    // Private

    /**
     * @param {SubmitEvent} e
     */
    _onLoginFormSubmit(e) {
        e.preventDefault();
        void this._login();
    }

    /** */
    _onUpdateButtonClick() {
        void this._run(() => this._update());
    }

    /** */
    _onLogoutButtonClick() {
        void this._run(async () => {
            await this._getCopy().logout();
            this._ankiController.reloadAnkiMobileInfo();
        });
    }

    /** */
    async _login() {
        const usernameInput = /** @type {HTMLInputElement} */ (this._usernameInput);
        const passwordInput = /** @type {HTMLInputElement} */ (this._passwordInput);
        const serverUrl = /** @type {HTMLInputElement} */ (this._serverInput).value.trim();
        const username = usernameInput.value.trim();
        const password = passwordInput.value;
        if (serverUrl.length === 0) {
            this._setStatus('Enter the URL of the sync server', true);
            return;
        }
        if (username.length === 0 || password.length === 0) {
            this._setStatus('Enter the username and the password', true);
            return;
        }
        await this._run(async () => {
            // Checks the URL before sending the password
            getEndpoint(serverUrl);
            this._setStatus('Logging in…', false);
            await this._getCopy().login(serverUrl, username, password);
            passwordInput.value = '';
            await this._update();
        });
    }

    /** */
    async _update() {
        this._setStatus('Reading the collection…', false);
        await this._getCopy().update({
            onProgress: ({noteCount}) => {
                this._setStatus(`Reading the collection… ${noteCount} ${noteCount === 1 ? 'note' : 'notes'}`, false);
            },
        });
        this._ankiController.reloadAnkiMobileInfo();
    }

    /**
     * Runs one action at a time, then shows the status, or the action's error.
     * @param {() => Promise<void>} action
     */
    async _run(action) {
        if (this._busy) { return; }
        this._busy = true;
        this._setButtonsDisabled(true);
        /** @type {?Error} */
        let error = null;
        try {
            await action();
        } catch (e) {
            error = toError(e);
        } finally {
            this._busy = false;
            this._setButtonsDisabled(false);
        }
        await this._updateStatus();
        if (error !== null) {
            this._setStatus(error.message, true);
        }
    }

    /** */
    async _updateStatus() {
        /** @type {?import('anki-sync').Status} */
        let status = null;
        try {
            status = await this._getCopy().getStatus();
        } catch (e) {
            this._setStatus(toError(e).message, true);
            return;
        }
        const loggedIn = status !== null;
        /** @type {HTMLElement} */ (this._loginContainer).hidden = loggedIn;
        /** @type {HTMLButtonElement} */ (this._updateButton).hidden = !loggedIn;
        /** @type {HTMLButtonElement} */ (this._logoutButton).hidden = !loggedIn;
        // The copy is of the collection on the server that was logged in to
        /** @type {HTMLInputElement} */ (this._serverInput).disabled = loggedIn;
        if (status === null) {
            this._setStatus('Not logged in', false);
            return;
        }
        const {serverUrl, username, updatedAt, noteCount} = status;
        const server = new URL(getEndpoint(serverUrl)).host;
        const copyStatus = updatedAt === null ?
            'The collection has not been read yet.' :
            `${noteCount} ${noteCount === 1 ? 'note' : 'notes'}, up to date at ${new Date(updatedAt).toLocaleString()}.`;
        this._setStatus(`Logged in to ${server} as ${username}. ${copyStatus}`, false);
    }

    /**
     * @param {string} message
     * @param {boolean} isError
     */
    _setStatus(message, isError) {
        const statusNode = /** @type {HTMLElement} */ (this._statusNode);
        statusNode.textContent = message;
        statusNode.classList.toggle('danger-text', isError);
    }

    /**
     * @param {boolean} disabled
     */
    _setButtonsDisabled(disabled) {
        for (const button of [this._updateButton, this._logoutButton, this._loginButton]) {
            if (button !== null) { button.disabled = disabled; }
        }
    }

    /**
     * @returns {AnkiCollectionCopy}
     */
    _getCopy() {
        return /** @type {AnkiCollectionCopy} */ (this._copy);
    }
}
