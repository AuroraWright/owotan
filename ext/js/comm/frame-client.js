/*
 * Copyright (C) 2023-2026  Yomitan Authors
 * Copyright (C) 2020-2022  Yomichan Authors
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

import {isObjectNotArray} from '../core/object-utilities.js';
import {deferPromise, generateId} from '../core/utilities.js';

export class FrameClient {
    /**
     * @param {import('../extension/web-extension.js').WebExtension} webExtension
     */
    constructor(webExtension) {
        /** @type {import('../extension/web-extension.js').WebExtension} */
        this._webExtension = webExtension;
        /** @type {?string} */
        this._secret = null;
        /** @type {?string} */
        this._token = null;
        /** @type {?number} */
        this._frameId = null;
        /** @type {?MessagePort} */
        this._port = null;
    }

    /** @type {number} */
    get frameId() {
        if (this._frameId === null) { throw new Error('Not connected'); }
        return this._frameId;
    }

    /**
     * A port to the frame, whose other end the frame received with the connection.
     * @type {MessagePort}
     */
    get port() {
        if (this._port === null) { throw new Error('Not connected'); }
        return this._port;
    }

    /**
     * @param {import('extension').HtmlElementWithContentWindow} frame
     * @param {string} targetOrigin
     * @param {number} hostFrameId
     * @param {import('frame-client').SetupFrameFunction} setupFrame
     * @param {number} [timeout]
     */
    async connect(frame, targetOrigin, hostFrameId, setupFrame, timeout = 10000) {
        const {secret, token, frameId, port} = await this._connectInternal(frame, targetOrigin, hostFrameId, setupFrame, timeout);
        this._secret = secret;
        this._token = token;
        this._frameId = frameId;
        this._port = port;
    }

    /**
     * @returns {boolean}
     */
    isConnected() {
        return (this._secret !== null);
    }

    /**
     * @template [T=unknown]
     * @param {T} data
     * @returns {import('frame-client').Message<T>}
     * @throws {Error}
     */
    createMessage(data) {
        if (!this.isConnected()) {
            throw new Error('Not connected');
        }
        return {
            token: /** @type {string} */ (this._token),
            secret: /** @type {string} */ (this._secret),
            data,
        };
    }

    /**
     * @param {import('extension').HtmlElementWithContentWindow} frame
     * @param {string} targetOrigin
     * @param {number} hostFrameId
     * @param {(frame: import('extension').HtmlElementWithContentWindow) => void} setupFrame
     * @param {number} timeout
     * @returns {Promise<{secret: string, token: string, frameId: number, port: MessagePort}>}
     */
    _connectInternal(frame, targetOrigin, hostFrameId, setupFrame, timeout) {
        return new Promise((resolve, reject) => {
            /** @type {Map<string, {token: string, port: MessagePort}>} */
            const tokenMap = new Map();
            /** @type {?import('core').Timeout} */
            let timer = null;
            const deferPromiseDetails = /** @type {import('core').DeferredPromiseDetails<void>} */ (deferPromise());
            const frameLoadedPromise = deferPromiseDetails.promise;
            let frameLoadedResolve = /** @type {?() => void} */ (deferPromiseDetails.resolve);
            let frameLoadedReject = /** @type {?(reason?: import('core').RejectionReason) => void} */ (deferPromiseDetails.reject);

            /**
             * @param {string} action
             * @param {import('core').SerializableObject} params
             * @param {Transferable[]} transfer
             * @throws {Error}
             */
            const postMessage = (action, params, transfer) => {
                const contentWindow = frame.contentWindow;
                if (contentWindow === null) { throw new Error('Frame missing content window'); }

                let validOrigin = true;
                try {
                    validOrigin = (contentWindow.location.origin === targetOrigin);
                } catch (e) {
                    // NOP
                }
                if (!validOrigin) { throw new Error('Unexpected frame origin'); }

                contentWindow.postMessage({action, params}, targetOrigin, transfer);
            };

            /** @type {import('extension').ChromeRuntimeOnMessageCallback<import('application').ApiMessageAny>} */
            const onMessage = (message) => {
                void onMessageInner(message);
                return false;
            };

            /**
             * @param {import('application').ApiMessageAny} message
             */
            const onMessageInner = async (message) => {
                try {
                    if (!isObjectNotArray(message)) { return; }
                    const {action, params} = message;
                    if (!isObjectNotArray(params)) { return; }
                    await frameLoadedPromise;
                    if (timer === null) { return; } // Done

                    switch (action) {
                        case 'frameEndpointReady':
                            {
                                const {secret} = params;
                                const token = generateId(16);
                                const {port1, port2} = new MessageChannel();
                                tokenMap.set(secret, {token, port: port1});
                                postMessage('frameEndpointConnect', {secret, token, hostFrameId}, [port2]);
                            }
                            break;
                        case 'frameEndpointConnected':
                            {
                                const {secret, token} = params;
                                const frameId = message.frameId;
                                const connection = tokenMap.get(secret);
                                if (typeof connection !== 'undefined' && token === connection.token && typeof frameId === 'number') {
                                    cleanup();
                                    resolve({secret, token, frameId, port: connection.port});
                                }
                            }
                            break;
                    }
                } catch (e) {
                    cleanup();
                    reject(e);
                }
            };

            const onLoad = () => {
                if (frameLoadedResolve === null) {
                    cleanup();
                    reject(new Error('Unexpected load event'));
                    return;
                }

                if (FrameClient.isFrameAboutBlank(frame)) {
                    return;
                }

                frameLoadedResolve();
                frameLoadedResolve = null;
                frameLoadedReject = null;
            };

            const cleanup = () => {
                if (timer === null) { return; } // Done
                clearTimeout(timer);
                timer = null;

                frameLoadedResolve = null;
                if (frameLoadedReject !== null) {
                    frameLoadedReject(new Error('Terminated'));
                    frameLoadedReject = null;
                }

                this._webExtension.removeMessageListener(onMessage);
                frame.removeEventListener('load', onLoad);
            };

            // Start
            timer = setTimeout(() => {
                cleanup();
                reject(new Error('Timeout'));
            }, timeout);

            this._webExtension.addMessageListener(onMessage);
            frame.addEventListener('load', onLoad);

            // Prevent unhandled rejections
            frameLoadedPromise.catch(() => {}); // NOP

            try {
                setupFrame(frame);
            } catch (e) {
                cleanup();
                reject(e);
            }
        });
    }

    /**
     * @param {import('extension').HtmlElementWithContentWindow} frame
     * @returns {boolean}
     */
    static isFrameAboutBlank(frame) {
        try {
            const contentDocument = frame.contentDocument;
            if (contentDocument === null) { return false; }
            const url = contentDocument.location.href;
            return /^about:blank(?:[#?]|$)/.test(url);
        } catch (e) {
            return false;
        }
    }
}
