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
 * Opens the share sheet with a file, from which it can be saved. Safari on iOS cannot download a file from an
 * extension page: a link to a blob URL only shows "WebKitBlobResource error 1", and a data URL is shown as a page.
 * The share sheet only opens within about 5 seconds of a tap, and not for the tap that answers a confirmation.
 * @param {Blob} blob
 * @param {string} fileName
 * @throws {Error} If the share sheet could not be opened.
 */
export async function shareFile(blob, fileName) {
    const file = new File([blob], fileName, {type: blob.type});
    try {
        await navigator.share({files: [file]});
    } catch (e) {
        // The share sheet was closed without saving or sharing the file
        if (e instanceof DOMException && e.name === 'AbortError') { return; }
        throw e;
    }
}
