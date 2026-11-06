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

import {isSafariExtension} from '../extension/app-extension.js';
import {getFieldMarkers} from './anki-util.js';

/**
 * This function returns whether an Anki field marker might require clipboard permissions.
 * This is speculative and may not guarantee that the field marker actually does require the permission,
 * as the custom handlebars template is not deeply inspected.
 * @param {string} marker
 * @returns {boolean}
 */
function ankiFieldMarkerMayUseClipboard(marker) {
    switch (marker) {
        case 'clipboard-image':
        case 'clipboard-text':
            return true;
        default:
            return false;
    }
}

/**
 * Safari has no clipboardRead permission. There the clipboard is read on macOS through the extension's app with
 * native messaging (ClipboardReader), which the extension always has, so clipboardRead stands for nativeMessaging.
 * @returns {boolean}
 */
function isClipboardReadThroughNativeMessaging() {
    return isSafariExtension();
}

/**
 * Converts the permissions Yomitan asks about into those the browser knows.
 * @param {chrome.permissions.Permissions} permissions
 * @param {boolean} removing Whether the permissions are to be removed, which nativeMessaging cannot be in Safari.
 * @returns {chrome.permissions.Permissions}
 */
function getBrowserPermissions(permissions, removing) {
    const {permissions: names} = permissions;
    if (typeof names === 'undefined' || !names.includes('clipboardRead') || !isClipboardReadThroughNativeMessaging()) { return permissions; }
    /** @type {chrome.runtime.ManifestPermission[]} */
    const browserNames = names.filter((name) => name !== 'clipboardRead');
    if (!removing && !browserNames.includes('nativeMessaging')) { browserNames.push('nativeMessaging'); }
    return {...permissions, permissions: browserNames};
}

/**
 * @param {chrome.permissions.Permissions} permissions
 * @returns {Promise<boolean>}
 */
export function hasPermissions(permissions) {
    return new Promise((resolve, reject) => {
        chrome.permissions.contains(getBrowserPermissions(permissions, false), (result) => {
            const e = chrome.runtime.lastError;
            if (e) {
                reject(new Error(e.message));
            } else {
                resolve(result);
            }
        });
    });
}

/**
 * @param {chrome.permissions.Permissions} permissions
 * @param {boolean} shouldHave
 * @returns {Promise<boolean>}
 */
export function setPermissionsGranted(permissions, shouldHave) {
    return (
        shouldHave ?
        new Promise((resolve, reject) => {
            chrome.permissions.request(getBrowserPermissions(permissions, false), (result) => {
                const e = chrome.runtime.lastError;
                if (e) {
                    reject(new Error(e.message));
                } else {
                    resolve(result);
                }
            });
        }) :
        new Promise((resolve, reject) => {
            chrome.permissions.remove(getBrowserPermissions(permissions, true), (result) => {
                const e = chrome.runtime.lastError;
                if (e) {
                    reject(new Error(e.message));
                } else {
                    resolve(!result);
                }
            });
        })
    );
}

/**
 * @returns {Promise<chrome.permissions.Permissions>}
 */
export function getAllPermissions() {
    return new Promise((resolve, reject) => {
        chrome.permissions.getAll((result) => {
            const e = chrome.runtime.lastError;
            if (e) {
                reject(new Error(e.message));
            } else {
                const {permissions} = result;
                if (typeof permissions !== 'undefined' && permissions.includes('nativeMessaging') && isClipboardReadThroughNativeMessaging()) {
                    result = {...result, permissions: [...permissions, 'clipboardRead']};
                }
                resolve(result);
            }
        });
    });
}

/**
 * @param {string} fieldValue
 * @returns {chrome.runtime.ManifestPermission[]}
 */
export function getRequiredPermissionsForAnkiFieldValue(fieldValue) {
    const markers = getFieldMarkers(fieldValue);
    for (const marker of markers) {
        if (ankiFieldMarkerMayUseClipboard(marker)) {
            return ['clipboardRead'];
        }
    }
    return [];
}

/**
 * @param {chrome.permissions.Permissions} permissions
 * @param {import('settings').ProfileOptions} options
 * @returns {boolean}
 */
export function hasRequiredPermissionsForOptions(permissions, options) {
    const permissionsSet = new Set(permissions.permissions);

    if (!permissionsSet.has('nativeMessaging') && (options.parsing.enableMecabParser || options.general.enableYomitanApi)) {
        return false;
    }

    if (!permissionsSet.has('clipboardRead')) {
        if (options.clipboard.enableBackgroundMonitor || options.clipboard.enableSearchPageMonitor) {
            return false;
        }
        const fieldsList = options.anki.cardFormats.map((cardFormat) => cardFormat.fields);

        for (const fields of fieldsList) {
            for (const {value: fieldValue} of Object.values(fields)) {
                const markers = getFieldMarkers(fieldValue);
                for (const marker of markers) {
                    if (ankiFieldMarkerMayUseClipboard(marker)) {
                        return false;
                    }
                }
            }
        }
    }

    return true;
}
