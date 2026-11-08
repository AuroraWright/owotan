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

import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {CrossFrameAPIPort} from '../ext/js/comm/cross-frame-api.js';

/** @typedef {ConstructorParameters<typeof CrossFrameAPIPort>[2]} Port */

/**
 * A port whose messages are kept, and that delivers the messages given to `receive`.
 * @returns {{port: Port, sent: unknown[], receive: (message: unknown) => void}}
 */
function createPort() {
    /** @type {((message: unknown) => void)[]} */
    const messageListeners = [];
    /** @type {unknown[]} */
    const sent = [];
    const createEvent = (/** @type {((message: unknown) => void)[]} */ listeners) => ({
        addListener: (/** @type {(message: unknown) => void} */ listener) => { listeners.push(listener); },
        removeListener: (/** @type {(message: unknown) => void} */ listener) => { listeners.splice(listeners.indexOf(listener), 1); },
    });
    const port = {
        onMessage: createEvent(messageListeners),
        onDisconnect: createEvent([]),
        postMessage: (/** @type {unknown} */ message) => { sent.push(message); },
    };
    return {
        port: /** @type {Port} */ (/** @type {unknown} */ (port)),
        sent,
        receive: (/** @type {unknown} */ message) => {
            for (const listener of messageListeners) { listener(message); }
        },
    };
}

describe('CrossFrameAPIPort', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    test('fails an invocation that is not acknowledged in time', async () => {
        const {port} = createPort();
        const commPort = new CrossFrameAPIPort(1, 2, port, new Map(), true);
        commPort.prepare();
        const promise = commPort.invoke('popupFactoryHide', {id: 'popup', changeFocus: false}, 3000, 10000);
        const result = expect(promise).rejects.toThrow('Acknowledgement timeout (popupFactoryHide)');
        await vi.advanceTimersByTimeAsync(3000);
        await result;
    });

    test('waits again when its timer runs late, as after the page was frozen', async () => {
        const {port, sent, receive} = createPort();
        const commPort = new CrossFrameAPIPort(1, 2, port, new Map(), true);
        commPort.prepare();
        const promise = commPort.invoke('popupFactoryIsVisible', {id: 'popup'}, 3000, 10000);
        const {id} = /** @type {{id: number}} */ (sent[0]);
        // Time passes while the timer does not run
        vi.setSystemTime(Date.now() + 20000);
        await vi.advanceTimersByTimeAsync(3000);
        receive({type: 'ack', id});
        vi.setSystemTime(Date.now() + 30000);
        await vi.advanceTimersByTimeAsync(10000);
        receive({type: 'result', id, data: {result: true}});
        await expect(promise).resolves.toBe(true);
    });
});
