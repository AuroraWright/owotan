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

/**
 * Whether the extension runs in Safari, whose extension URLs have a scheme of their own.
 * @returns {boolean}
 */
export function isSafariExtension() {
    return new URL(import.meta.url).protocol === 'safari-web-extension:';
}

/**
 * Sends a message to the app extension that holds the extension in Safari (SafariWebExtensionHandler.swift).
 * @param {{[key: string]: string|number}} message
 * @param {string} errorMessage What failed, for the error if the app extension cannot be reached or fails.
 * @returns {Promise<{[key: string]: unknown}>}
 */
export function sendAppExtensionMessage(message, errorMessage) {
    return new Promise((resolve, reject) => {
        // Safari sends native messages to the app extension whichever application is named.
        chrome.runtime.sendNativeMessage('application.id', message, (/** @type {unknown} */ response) => {
            const error = chrome.runtime.lastError;
            if (error) {
                reject(new Error(`${errorMessage}: ${error.message}`));
            } else if (typeof response !== 'object' || response === null) {
                reject(new Error(errorMessage));
            } else if ('error' in response) {
                reject(new Error(`${errorMessage}: ${String(response.error)}`));
            } else {
                resolve(/** @type {{[key: string]: unknown}} */ (response));
            }
        });
    });
}
