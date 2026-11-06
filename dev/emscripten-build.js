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

// What the scripts that build native libraries with Emscripten (dev/bin/build-*.js) share.

import {execFileSync} from 'child_process';
import {existsSync, mkdirSync} from 'fs';
import path from 'path';

/**
 * Runs a command, showing its output.
 * @param {string} command
 * @param {string[]} args
 * @param {string} [cwd]
 */
export function run(command, args, cwd) {
    execFileSync(command, args, {cwd, stdio: 'inherit'});
}

/**
 * Checks out a commit of a repository in `directory`, which is cloned first if it is not there, and discards
 * anything else in it, such as what an earlier build left.
 * @param {string} repository
 * @param {string} commit
 * @param {string} directory
 */
export function checkOutCommit(repository, commit, directory) {
    mkdirSync(path.dirname(directory), {recursive: true});
    if (!existsSync(directory)) {
        run('git', ['clone', repository, directory]);
    }
    run('git', ['fetch', '--quiet', 'origin', commit], directory);
    run('git', ['reset', '--quiet', '--hard', commit], directory);
    run('git', ['clean', '--quiet', '-fdx'], directory);
}
