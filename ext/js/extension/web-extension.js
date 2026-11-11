/*
 * Copyright (C) 2024-2026  Yomitan Authors
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

import {EventDispatcher} from '../core/event-dispatcher.js';
import {parseJson} from '../core/json.js';
import {toError} from '../core/to-error.js';
import {isSafariExtension} from './app-extension.js';

/** How long, in milliseconds, a frame's port for its messages is kept before it can be opened again. */
const MESSAGE_PORT_RECONNECT_MINIMUM_AGE = 1000;

/**
 * Reopens the port for the frame's messages of each instance in this frame that opened one. A frame has more than one
 * instance, and the one that sends a message is not always the one that listens.
 * @type {Set<() => void>}
 */
const messagePortReconnectors = new Set();

/**
 * The ID of this frame's tab that the backend gave when the frame started. See setFrameTabId.
 * @type {?number}
 */
let frameTabId = null;

/**
 * Sets the ID of this frame's tab that the frame uses. Safari gives the tabs new IDs when it reloads the extension, and
 * the frame keeps using this one, so it gives it to the backend with the port for its messages, which it opens again
 * then, for the backend to know which tab it means.
 * @param {?number} tabId
 */
export function setFrameTabId(tabId) {
    frameTabId = tabId;
}

/**
 * @augments EventDispatcher<import('web-extension').Events>
 */
export class WebExtension extends EventDispatcher {
    constructor() {
        super();
        /** @type {boolean} */
        this._unloaded = false;
        /** @type {?string} */
        this._extensionBaseUrl = null;
        try {
            this._extensionBaseUrl = this.getUrl('/');
        } catch (e) {
            // NOP
        }
        /** @type {Set<import('extension').ChromeRuntimeOnMessageCallback<import('application').ApiMessageAny>>} */
        this._messageListeners = new Set();
        /** @type {?chrome.runtime.Port} */
        this._messagePort = null;
        /** @type {number} */
        this._messagePortConnectTime = 0;
        /** @type {() => void} */
        this._reconnectMessagePortBind = this._reconnectMessagePort.bind(this);
        /** @type {string} */
        this._extensionName = 'Extension';
        try {
            const {name, version} = chrome.runtime.getManifest();
            this._extensionName = `${name} ${version}`;
        } catch (e) {
            // NOP
        }
    }

    /** @type {boolean} */
    get unloaded() {
        return this._unloaded;
    }

    /** @type {string} */
    get extensionName() {
        return this._extensionName;
    }

    /**
     * @param {string} path
     * @returns {string}
     */
    getUrl(path) {
        return chrome.runtime.getURL(path);
    }

    /**
     * @param {unknown} message
     * @param {(response: unknown) => void} responseCallback
     * @throws {Error}
     */
    sendMessage(message, responseCallback) {
        try {
            if (isSafariExtension()) {
                // Safari reorders the keys of objects in messages, and the order of some matters, such as a note's fields.
                // JSON keeps it, and the backend answers a message sent as JSON with JSON (Backend._onMessageWrapper).
                chrome.runtime.sendMessage(JSON.stringify(message), (/** @type {unknown} */ response) => {
                    if (typeof response !== 'string') {
                        responseCallback(response);
                        return;
                    }
                    /** @type {import('web-extension').JsonResponse} */
                    const {response: response2, messagePortMissing} = parseJson(response);
                    if (messagePortMissing) {
                        for (const reconnect of messagePortReconnectors) { reconnect(); }
                    }
                    responseCallback(response2);
                });
            } else {
                chrome.runtime.sendMessage(message, responseCallback);
            }
        } catch (error) {
            this.triggerUnloaded();
            throw toError(error);
        }
    }

    /**
     * @param {unknown} message
     * @returns {Promise<unknown>}
     */
    sendMessagePromise(message) {
        return new Promise((resolve, reject) => {
            try {
                this.sendMessage(message, (response) => {
                    const error = this.getLastError();
                    if (error !== null) {
                        reject(error);
                    } else {
                        resolve(response);
                    }
                });
            } catch (error) {
                reject(error);
            }
        });
    }

    /**
     * Listens for the messages that the backend sends to this page's frame.
     * @param {import('extension').ChromeRuntimeOnMessageCallback<import('application').ApiMessageAny>} callback
     */
    addMessageListener(callback) {
        chrome.runtime.onMessage.addListener(callback);
        this._messageListeners.add(callback);
        this._connectMessagePort();
    }

    /**
     * @param {import('extension').ChromeRuntimeOnMessageCallback<import('application').ApiMessageAny>} callback
     */
    removeMessageListener(callback) {
        chrome.runtime.onMessage.removeListener(callback);
        this._messageListeners.delete(callback);
    }

    /**
     * @returns {?Error}
     */
    getLastError() {
        const {lastError} = chrome.runtime;
        if (lastError) {
            if (lastError instanceof Error) { return lastError; }
            const {message} = lastError;
            return new Error(typeof message === 'string' ? message : 'An unknown web extension error occurred');
        }
        return null;
    }

    /** */
    triggerUnloaded() {
        if (this._unloaded) { return; }
        this._unloaded = true;
        this.trigger('unloaded', {});
    }

    /**
     * Checks whether or not a URL is an extension URL.
     * @param {string} url The URL to check.
     * @returns {boolean} `true` if the URL is an extension URL, `false` otherwise.
     */
    isExtensionUrl(url) {
        return this._extensionBaseUrl !== null && url.startsWith(this._extensionBaseUrl);
    }

    // Private

    /**
     * Safari does not deliver tabs.sendMessage to extension pages, nor to any frame of a tab that was open when
     * the extension started, even after the tab reloads. So there the backend sends to a frame through a port
     * that the frame opens, and which it opens again when the backend stops.
     */
    _connectMessagePort() {
        if (this._messagePort !== null || this._extensionBaseUrl === null || !isSafariExtension()) { return; }
        /** @type {chrome.runtime.Port} */
        let port;
        try {
            /** @type {import('web-extension').MessagePortDetails} */
            const details = {name: 'tabMessages', tabId: frameTabId};
            port = chrome.runtime.connect({name: JSON.stringify(details)});
        } catch (e) {
            this.triggerUnloaded();
            return;
        }
        this._messagePort = port;
        this._messagePortConnectTime = Date.now();
        messagePortReconnectors.add(this._reconnectMessagePortBind);
        port.onMessage.addListener(this._onMessagePortMessage.bind(this, port));
        port.onDisconnect.addListener(() => {
            this.getLastError();
            if (this._messagePort !== port) { return; }
            this._messagePort = null;
            this._connectMessagePort();
        });
    }

    /**
     * Opens the port for this frame's messages again when the backend has no port for this frame. When Safari reloads
     * the extension, as the backend does on iOS after Safari was suspended, the frames' ports are closed without
     * a disconnect event, so the backend could no longer reach them.
     */
    _reconnectMessagePort() {
        const port = this._messagePort;
        // A port that has just been opened may only reach the backend after a message sent since
        if (port === null || Date.now() - this._messagePortConnectTime < MESSAGE_PORT_RECONNECT_MINIMUM_AGE) { return; }
        this._messagePort = null;
        try {
            port.disconnect();
        } catch (e) {
            // NOP
        }
        this._connectMessagePort();
    }

    /**
     * @param {chrome.runtime.Port} port
     * @param {import('web-extension').PortMessage} data
     */
    _onMessagePortMessage(port, {id, message}) {
        // See Backend._keepSafariBackgroundLoaded
        if (message === null) { return; }
        let responded = false;
        /** @type {import('extension').ChromeRuntimeMessageSendResponseFunction} */
        const sendResponse = (response) => {
            if (responded) { return; }
            responded = true;
            if (id === null) { return; }
            /** @type {import('web-extension').PortResponse} */
            const portResponse = {id, response};
            try {
                port.postMessage(portResponse);
            } catch (e) {
                // The port disconnected, and the backend no longer waits for the response
            }
        };
        let respondsLater = false;
        for (const listener of this._messageListeners) {
            if (listener(message, {id: chrome.runtime.id}, sendResponse) === true) { respondsLater = true; }
        }
        // As with runtime.onMessage, a message that no listener answers or will answer gets no response.
        if (!respondsLater) { sendResponse(); }
    }
}
