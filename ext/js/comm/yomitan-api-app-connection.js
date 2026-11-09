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

import {readResponseJson} from '../core/json.js';
import {log} from '../core/log.js';
import {toError} from '../core/to-error.js';
import {promiseTimeout} from '../core/utilities.js';
import {sendAppExtensionMessage} from '../extension/app-extension.js';

/**
 * How long the extension waits for itself to answer a request before it takes the next.
 */
const RESPONSE_TIMEOUT = 30000;
/** How long to wait before asking again when the server cannot be reached. */
const RETRY_DELAY = 1000;
/** How many polls in a row may fail before the app is asked to start again. */
const FAILURES_BEFORE_START = 5;

/**
 * Connects the Yomitan API to the Safari app on macOS, which serves it in place of the native messaging component
 * that other browsers run (dev/safari/AppDelegate.swift). The app holds each request until the extension polls for
 * it, and the extension posts the response back. This has the interface of the native messaging port that it
 * replaces: requests arrive as `onMessage`, one at a time, and `postMessage` answers the current one.
 */
export class YomitanApiAppConnection {
    /**
     * @param {string} serverUrl
     */
    constructor(serverUrl) {
        /** @type {string} */
        this._serverUrl = serverUrl;
        /** @type {AbortController} */
        this._abortController = new AbortController();
        /** @type {?number} */
        this._requestId = null;
        /** @type {?() => void} */
        this._onResponded = null;
        /** @type {ConnectionEvent<(message: unknown) => void>} */
        this.onMessage = new ConnectionEvent();
    }

    /** */
    start() {
        void this._run();
    }

    /**
     * Answers the current request.
     * @param {unknown} message `{responseStatusCode, data}`, as the native messaging component takes it.
     */
    postMessage(message) {
        const id = this._requestId;
        if (id === null || typeof message !== 'object' || message === null) { return; }
        this._requestId = null;
        const {responseStatusCode, data} = /** @type {{responseStatusCode?: unknown, data?: unknown}} */ (message);
        const body = JSON.stringify({id, responseStatusCode, data: JSON.stringify(data ?? null)});
        fetch(`${this._serverUrl}/__yomitan/respond`, {method: 'POST', body, signal: this._abortController.signal}).catch(() => {});
        if (this._onResponded !== null) { this._onResponded(); }
    }

    /** */
    disconnect() {
        this._abortController.abort();
    }

    // Private

    /** */
    async _run() {
        const {signal} = this._abortController;
        let failures = 0;
        await this._startApp();
        while (!signal.aborted) {
            /** @type {Response} */
            let response;
            try {
                response = await fetch(`${this._serverUrl}/__yomitan/poll`, {method: 'POST', signal});
            } catch (e) {
                if (signal.aborted) { return; }
                // The app may still be starting, or it quit.
                if (++failures % FAILURES_BEFORE_START === 0) {
                    await this._startApp();
                }
                await promiseTimeout(RETRY_DELAY);
                continue;
            }
            failures = 0;
            if (response.status === 204) { continue; }
            if (!response.ok) {
                await promiseTimeout(RETRY_DELAY);
                continue;
            }

            /** @type {{id: number, action: string, params: unknown, body: string}} */
            const {id, action, params, body} = await readResponseJson(response);
            this._requestId = id;
            /** @type {Promise<void>} */
            const responded = new Promise((resolve) => {
                this._onResponded = resolve;
                setTimeout(resolve, RESPONSE_TIMEOUT);
            });
            for (const callback of this.onMessage.callbacks) {
                callback({action, params, body});
            }
            await responded;
            this._onResponded = null;
        }
    }

    /** Has the app extension start the app, which serves the requests, unless it is running. */
    async _startApp() {
        try {
            const port = Number.parseInt(new URL(this._serverUrl).port || '80', 10);
            await sendAppExtensionMessage({action: 'startApiServer', port}, 'Could not start the OwOtan app, which serves the Yomitan API');
        } catch (e) {
            log.error(toError(e));
        }
    }
}

/**
 * An event of the connection, with the interface of a web extension event.
 * @template {(...args: never[]) => void} TCallback
 */
class ConnectionEvent {
    constructor() {
        /** @type {Set<TCallback>} */
        this.callbacks = new Set();
    }

    /**
     * @param {TCallback} callback
     */
    addListener(callback) {
        this.callbacks.add(callback);
    }

    /**
     * @param {TCallback} callback
     */
    removeListener(callback) {
        this.callbacks.delete(callback);
    }
}
