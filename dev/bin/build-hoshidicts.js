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

// Builds the hoshidicts dictionary engine into ext/lib/hoshidicts.{js,wasm}, and
// with threads, for imports in cross-origin isolated pages, into
// ext/lib/hoshidicts-threads.{js,wasm}.
// Needs git, cmake, ninja and an activated Emscripten SDK (emcmake on PATH).
// The pinned hoshidicts commit is checked out under node_modules/.cache, which
// no linter or test runner looks in, and dev/hoshidicts/hoshidicts.patch, the
// changes Yomitan needs, applied to it.

import {execFileSync} from 'child_process';
import {copyFileSync, existsSync, mkdirSync} from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

const repository = 'https://github.com/bee-san/hoshidicts';
const commit = 'e5751e88328969b2e0217a0caa0eebc36b6e4089';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.join(dirname, '..', 'hoshidicts');
const buildDirectory = path.join(dirname, '..', '..', 'node_modules', '.cache', 'hoshidicts');
const sourceDirectory = path.join(buildDirectory, 'hoshidicts');
const cmakeDirectory = path.join(buildDirectory, 'cmake');
const cmakeThreadsDirectory = path.join(buildDirectory, 'cmake-threads');
const outputDirectory = path.join(dirname, '..', '..', 'ext', 'lib');

/**
 * @param {string} command
 * @param {string[]} args
 * @param {string} [cwd]
 */
function run(command, args, cwd) {
    execFileSync(command, args, {cwd, stdio: 'inherit'});
}

mkdirSync(buildDirectory, {recursive: true});
if (!existsSync(sourceDirectory)) {
    run('git', ['clone', repository, sourceDirectory]);
}
run('git', ['fetch', '--quiet', 'origin', commit], sourceDirectory);
run('git', ['reset', '--quiet', '--hard', commit], sourceDirectory);
run('git', ['clean', '--quiet', '-fdx'], sourceDirectory);
run('git', ['submodule', 'update', '--quiet', '--init', '--recursive'], sourceDirectory);
run('git', ['apply', path.join(projectDirectory, 'hoshidicts.patch')], sourceDirectory);

// The single-threaded module, for lookups and for imports where threads are unavailable, and the threaded one.
for (const [directory, threads] of /** @type {[string, boolean][]} */ ([[cmakeDirectory, false], [cmakeThreadsDirectory, true]])) {
    run('emcmake', ['cmake', '-S', projectDirectory, '-B', directory, '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release', `-DHOSHIDICTS_SOURCE_DIR=${sourceDirectory}`, `-DYOMITAN_HOSHIDICTS_THREADS=${threads ? 'ON' : 'OFF'}`]);
    run('cmake', ['--build', directory]);
}

mkdirSync(outputDirectory, {recursive: true});
for (const [directory, fileName] of [
    [cmakeDirectory, 'hoshidicts.js'],
    [cmakeDirectory, 'hoshidicts.wasm'],
    [cmakeThreadsDirectory, 'hoshidicts-threads.js'],
    [cmakeThreadsDirectory, 'hoshidicts-threads.wasm'],
]) {
    copyFileSync(path.join(directory, fileName), path.join(outputDirectory, fileName));
}
