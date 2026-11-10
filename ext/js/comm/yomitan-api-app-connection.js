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
 * How many requests the extension works on at once, so that quick ones, as a version check or a lookup, are not
 * held up by a long one, as a tokenize of a long text, while not taking on more work than it can do.
 */
const MAX_CONCURRENT_REQUESTS = 4;
/**
 * How long the extension waits for itself to answer a request before it takes another in its place, in case it
 * never does. A request still being worked on keeps the extension busy, so this is much longer than the app waits.
 */
const RESPONSE_TIMEOUT = 2 * 60 * 1000;
/** How long to wait before asking again when the server cannot be reached. */
const RETRY_DELAY = 1000;
/** How many polls in a row may fail before the app is asked to start again. */
const FAILURES_BEFORE_START = 5;

/**
 * Connects the Yomitan API to the Safari app on macOS, which serves it in place of the native messaging component
 * that other browsers run (dev/safari/AppDelegate.swift). The app holds each request until the extension polls for
 * it, and the extension posts the response back. This has the interface of the native messaging port that it
 * replaces: requests arrive as `onMessage`, several at a time, and `postMessage` answers the one whose `params`
 * object it carries back, as YomitanApi's answers do.
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
        /**
         * The requests being worked on, by their `params` object.
         * @type {Map<unknown, {id: number, resolve: () => void}>}
         */
        this._requests = new Map();
        /** @type {number} */
        this._failures = 0;
        /** @type {ConnectionEvent<(message: unknown) => void>} */
        this.onMessage = new ConnectionEvent();
    }

    /** */
    start() {
        void this._run();
    }

    /**
     * Answers the request that `message.params` came with.
     * @param {unknown} message `{params, responseStatusCode, data}`, as the native messaging component takes it.
     */
    postMessage(message) {
        if (typeof message !== 'object' || message === null) { return; }
        const {params, responseStatusCode, data} = /** @type {{params?: unknown, responseStatusCode?: unknown, data?: unknown}} */ (message);
        const request = this._requests.get(params);
        if (typeof request === 'undefined') { return; }
        this._requests.delete(params);
        const body = JSON.stringify({id: request.id, responseStatusCode, data: JSON.stringify(data ?? null)});
        fetch(`${this._serverUrl}/__yomitan/respond`, {method: 'POST', body, signal: this._abortController.signal}).catch(() => {});
        request.resolve();
    }

    /** */
    disconnect() {
        this._abortController.abort();
    }

    // Private

    /** */
    async _run() {
        await this._startApp();
        const polls = [];
        for (let i = 0; i < MAX_CONCURRENT_REQUESTS; ++i) {
            polls.push(this._poll());
        }
        await Promise.all(polls);
    }

    /**
     * Polls for a request and works on it, one after another, until disconnected.
     */
    async _poll() {
        const {signal} = this._abortController;
        while (!signal.aborted) {
            /** @type {Response} */
            let response;
            try {
                response = await fetch(`${this._serverUrl}/__yomitan/poll`, {method: 'POST', signal});
            } catch (e) {
                if (signal.aborted) { return; }
                // The app may still be starting, or it quit.
                if (++this._failures % FAILURES_BEFORE_START === 0) {
                    await this._startApp();
                }
                await promiseTimeout(RETRY_DELAY);
                continue;
            }
            this._failures = 0;
            if (response.status === 204) { continue; }
            if (!response.ok) {
                await promiseTimeout(RETRY_DELAY);
                continue;
            }

            /** @type {{id: number, action: string, params: unknown, body: string}} */
            const {id, action, params: rawParams, body} = await readResponseJson(response);
            // The answer is told from those of other requests by this object, which each request has its own of
            const params = typeof rawParams === 'object' && rawParams !== null ? rawParams : {};
            await new Promise((resolve) => {
                const timer = setTimeout(() => {
                    this._requests.delete(params);
                    resolve(void 0);
                }, RESPONSE_TIMEOUT);
                const onResponded = () => {
                    clearTimeout(timer);
                    resolve(void 0);
                };
                this._requests.set(params, {id, resolve: onResponded});
                for (const callback of this.onMessage.callbacks) {
                    callback({action, params, body});
                }
            });
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
