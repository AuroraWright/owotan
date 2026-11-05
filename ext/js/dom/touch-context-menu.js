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

/** How long a touch has to be held to open a context menu, in milliseconds. */
const LONG_PRESS_DURATION = 500;
/** How far a touch can move, in pixels, and still be held rather than dragged. */
const LONG_PRESS_MOVE_TOLERANCE = 10;

/**
 * Opens context menus on a long press, for Safari on iOS, which fires no `contextmenu` event for one, as Chrome on
 * Android does. A long press dispatches a `contextmenu` event at the element pressed; when a listener handles it,
 * as the menus of the audio buttons do, lifting the touch does not also click the element.
 */
export class TouchContextMenu {
    /**
     * @param {EventTarget} root
     */
    constructor(root) {
        /** @type {EventTarget} */
        this._root = root;
        /** @type {?import('core').Timeout} */
        this._timer = null;
        /** @type {?Touch} */
        this._touch = null;
        /** @type {boolean} */
        this._handled = false;
    }

    /** */
    prepare() {
        this._root.addEventListener('touchstart', this._onTouchStart.bind(this), {capture: true, passive: true});
        this._root.addEventListener('touchmove', this._onTouchMove.bind(this), {capture: true, passive: true});
        this._root.addEventListener('touchend', this._onTouchEnd.bind(this), {capture: true, passive: false});
        this._root.addEventListener('touchcancel', this._onTouchCancel.bind(this), {capture: true, passive: true});
    }

    // Private

    /**
     * @param {Event} e
     */
    _onTouchStart(e) {
        this._cancel();
        this._handled = false;
        const {touches} = /** @type {TouchEvent} */ (e);
        if (touches.length !== 1) { return; }
        this._touch = touches[0];
        this._timer = setTimeout(this._onLongPress.bind(this), LONG_PRESS_DURATION);
    }

    /**
     * @param {Event} e
     */
    _onTouchMove(e) {
        const touch = this._touch;
        if (touch === null) { return; }
        const moved = /** @type {TouchEvent} */ (e).touches[0];
        if (
            typeof moved === 'undefined' ||
            Math.abs(moved.clientX - touch.clientX) > LONG_PRESS_MOVE_TOLERANCE ||
            Math.abs(moved.clientY - touch.clientY) > LONG_PRESS_MOVE_TOLERANCE
        ) {
            this._cancel();
        }
    }

    /**
     * @param {Event} e
     */
    _onTouchEnd(e) {
        this._cancel();
        if (!this._handled) { return; }
        this._handled = false;
        // Keeps the touch from clicking the element whose menu it opened.
        e.preventDefault();
    }

    /** */
    _onTouchCancel() {
        this._cancel();
        this._handled = false;
    }

    /** */
    _onLongPress() {
        this._timer = null;
        const touch = this._touch;
        this._touch = null;
        if (touch === null) { return; }
        const {target, clientX, clientY, screenX, screenY} = touch;
        const event = new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            composed: true,
            view: window,
            button: 2,
            clientX,
            clientY,
            screenX,
            screenY,
        });
        this._handled = !target.dispatchEvent(event);
    }

    /** */
    _cancel() {
        if (this._timer !== null) {
            clearTimeout(this._timer);
            this._timer = null;
        }
        this._touch = null;
    }
}
