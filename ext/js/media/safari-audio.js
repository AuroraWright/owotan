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
 * Whether Safari plays audio through the app extension (NativeAudio). iOS lets its app extension start audio only with
 * the background mode for audio, which the App Store does not allow in an app extension, so
 * dev/bin/build-safari-app.js sets this to `false` for App Store builds. Audio then plays on a shared audio element in
 * the page (SharedAudioElement), which gestures in the page and the popup unlock.
 */
export const safariNativeAudio = true;
