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

/** A declaration list that sets `content` to nothing, as a rule that hides a marker has. */
const hidesMarkerPattern = /(?:^|;)\s*content\s*:\s*(?:""|''|none)\s*(?:!important\s*)?(?:;|$)/;

/**
 * Adapts CSS written for Chrome and Firefox, such as dictionary styles and custom popup CSS, to WebKit.
 * @param {string} css
 * @returns {string}
 */
export function adaptCssForWebKit(css) {
    return addSummaryListStyleRules(addWebKitUserSelect(css));
}

/**
 * Adds `-webkit-user-select` after each `user-select`, since WebKit supports it only with its prefix.
 * Dictionaries use `user-select: all`, for example, to select a whole tag with one click.
 * @param {string} css
 * @returns {string}
 */
function addWebKitUserSelect(css) {
    return css.replace(/(^|[{;\s])user-select(\s*:\s*[^;{}]+)/g, '$1user-select$2;-webkit-user-select$2');
}

/**
 * WebKit ignores `content` in `::marker`, so the `summary::marker { content: "" }` rules that hide the disclosure
 * triangle in Chrome and Firefox don't hide it. This adds `summary { list-style: none }` after each of them, which
 * does, in the same block so that it keeps their scope.
 * @param {string} css
 * @returns {string}
 */
function addSummaryListStyleRules(css) {
    return css.replace(/([^{};]+)\{([^{}]*)\}/g, (rule, /** @type {string} */ selectorList, /** @type {string} */ declarations) => {
        if (!hidesMarkerPattern.test(declarations)) { return rule; }
        const selectors = [];
        for (const selector of selectorList.split(',')) {
            const match = /^(.*\bsummary)::marker$/.exec(selector.trim());
            if (match !== null) { selectors.push(match[1]); }
        }
        return selectors.length > 0 ? `${rule}\n${selectors.join(', ')} { list-style: none; }` : rule;
    });
}
