/*
 * Copyright (C) 2023-2026  Yomitan Authors
 * Copyright (C) 2019-2022  Yomichan Authors
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

import {Application} from '../application.js';
import {log} from '../core/log.js';
import {HotkeyHandler} from '../input/hotkey-handler.js';
import {Frontend} from './frontend.js';
import {PopupFactory} from './popup-factory.js';

/**
 * How often a page checks whether it was frozen, in milliseconds.
 */
const FROZEN_PAGE_CHECK_INTERVAL = 1000;

/**
 * How late a check must run for the page to have been frozen, in milliseconds.
 */
const FROZEN_PAGE_DELAY = 2000;

await Application.main(false, async (application) => {
    const hotkeyHandler = new HotkeyHandler();
    hotkeyHandler.prepare(application.crossFrame);

    const popupFactory = new PopupFactory(application);
    popupFactory.prepare();

    const {browser, platform} = await application.api.getEnvironmentInfo();

    const frontend = new Frontend({
        application,
        popupFactory,
        depth: 0,
        parentPopupId: null,
        parentFrameId: null,
        useProxyPopup: false,
        pageType: 'web',
        canUseWindowPopup: true,
        allowRootFramePopupProxy: true,
        childrenSupported: true,
        hotkeyHandler,
        browser: browser,
    });
    await frontend.prepare();

    if (browser === 'safari' && window === window.parent) {
        // See Backend._onApiPageVisibilityChanged
        let reportedVisible = false;
        let lastCheckTime = Date.now();
        const checkVisibility = () => {
            const time = Date.now();
            const visible = (document.visibilityState === 'visible');
            // Safari on iOS often freezes the page when it leaves for another app before the page learns that it is
            // hidden, which shows as a check that runs late.
            const frozenTime = (reportedVisible && visible && time - lastCheckTime >= FROZEN_PAGE_DELAY) ? lastCheckTime : null;
            lastCheckTime = time;
            if (visible === reportedVisible && frozenTime === null) { return; }
            reportedVisible = visible;
            application.api.pageVisibilityChanged(visible, time, frozenTime).catch((error) => {
                if (!application.webExtension.unloaded) { log.error(error); }
            });
        };
        document.addEventListener('visibilitychange', checkVisibility, false);
        if (platform.os === 'ios') {
            setInterval(checkVisibility, FROZEN_PAGE_CHECK_INTERVAL);
        }
        checkVisibility();
    }
});
