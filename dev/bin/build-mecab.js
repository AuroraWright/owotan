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

// Builds MeCab into ext/lib/mecab.{js,wasm}, for browsers whose extensions cannot
// reach the native MeCab component, such as Safari.
// Needs git, cmake, ninja and an activated Emscripten SDK (emcmake on PATH).
// The pinned MeCab commit is checked out under node_modules/.cache, which no
// linter or test runner looks in.

import {copyFileSync, mkdirSync} from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import {checkOutCommit, run} from '../emscripten-build.js';

const repository = 'https://github.com/taku910/mecab';
const commit = '61b90ba6e669dc2d7d533d4a80d206f3b31d52b1';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.join(dirname, '..', 'mecab');
const buildDirectory = path.join(dirname, '..', '..', 'node_modules', '.cache', 'mecab');
const sourceDirectory = path.join(buildDirectory, 'mecab');
const cmakeDirectory = path.join(buildDirectory, 'cmake');
const outputDirectory = path.join(dirname, '..', '..', 'ext', 'lib');

checkOutCommit(repository, commit, sourceDirectory);

run('emcmake', ['cmake', '-S', projectDirectory, '-B', cmakeDirectory, '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release', `-DMECAB_SOURCE_DIR=${sourceDirectory}`]);
run('cmake', ['--build', cmakeDirectory]);

mkdirSync(outputDirectory, {recursive: true});
for (const fileName of ['mecab.js', 'mecab.wasm']) {
    copyFileSync(path.join(cmakeDirectory, fileName), path.join(outputDirectory, fileName));
}
