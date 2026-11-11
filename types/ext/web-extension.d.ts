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

import type * as Application from './application';

export type Events = {
    unloaded: Record<string, never>;
};

/**
 * A message that the backend sends to a frame through the frame's port, with the ID the frame responds with, if any.
 * A `null` message only keeps Safari from unloading the background page, and the frame ignores it.
 */
export type PortMessage = {
    id: number | null;
    message: Application.ApiMessageAny | null;
};

/** A frame's response to a message that the backend sent through the frame's port. */
export type PortResponse = {
    id: number;
    response: unknown;
};

/**
 * The name of the port that a frame opens to receive its messages, as JSON. Safari gives the tabs new IDs when it
 * reloads the extension, so the frame also gives the ID its tab had when it started, which it keeps using.
 */
export type MessagePortDetails = {
    name: 'tabMessages';
    tabId: number | null;
};

/** The backend's answer in Safari to a message sent as JSON, as JSON. */
export type JsonResponse = {
    response?: unknown;
    /** Whether the frame that sent the message has no port for its messages in the backend. */
    messagePortMissing: boolean;
};
