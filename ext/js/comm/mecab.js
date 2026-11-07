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

import {EventListenerCollection} from '../core/event-listener-collection.js';
import {toError} from '../core/to-error.js';

/**
 * This class is used to parse text into individual terms with MeCab, compiled to WebAssembly, which runs in a worker
 * (mecab-worker-main.js) with the dictionaries that it stores.
 */
export class Mecab {
    /**
     * Creates a new instance of the class.
     * @param {?() => Promise<MessagePort>} [connectWorker] Connects to a worker that runs elsewhere, for contexts that
     *   cannot start workers, such as Chrome's service worker. By default, the worker is started here.
     */
    constructor(connectWorker = null) {
        /** @type {?() => Promise<MessagePort>} */
        this._connectWorker = connectWorker;
        /** @type {?import('mecab').Connection} */
        this._port = null;
        /** @type {number} */
        this._sequence = 0;
        /** @type {Map<number, {resolve: (value: unknown) => void, reject: (reason?: unknown) => void, timer: import('core').Timeout}>} */
        this._invocations = new Map();
        /** @type {EventListenerCollection} */
        this._eventListeners = new EventListenerCollection();
        /**
         * The worker reads the dictionaries for its first request, and an import writes one.
         * @type {number}
         */
        this._timeout = 60000;
        /** @type {boolean} */
        this._enabled = false;
        /** @type {?Promise<void>} */
        this._setupPortPromise = null;
    }

    /**
     * Returns whether or not the component is enabled.
     * @returns {boolean} Whether or not the object is enabled.
     */
    isEnabled() {
        return this._enabled;
    }

    /**
     * Changes whether or not the component connection is enabled.
     * @param {boolean} enabled A boolean indicating whether or not the component should be enabled.
     */
    setEnabled(enabled) {
        this._enabled = !!enabled;
        if (!this._enabled && this._port !== null) {
            this._clearPort();
        }
    }

    /**
     * Disconnects the current port, but does not disable future connections.
     */
    disconnect() {
        if (this._port !== null) {
            this._clearPort();
        }
    }

    /**
     * Returns whether or not the connection to the worker is active.
     * @returns {boolean} `true` if the connection is active, `false` otherwise.
     */
    isConnected() {
        return (this._port !== null);
    }

    /**
     * Returns whether or not any invocation is currently active.
     * @returns {boolean} `true` if an invocation is active, `false` otherwise.
     */
    isActive() {
        return (this._invocations.size > 0);
    }

    /**
     * Parses a string of Japanese text into arrays of lines and terms.
     *
     * Return value format:
     * ```js
     * [
     *     {
     *         name: (string),
     *         lines: [
     *             {term: (string), reading: (string), source: (string)},
     *             ...
     *         ]
     *     },
     *     ...
     * ]
     * ```
     * @param {string} text The string to parse.
     * @returns {Promise<import('mecab').ParseResult[]>} A collection of parsing results of the text.
     */
    async parseText(text) {
        await this._setupPortWrapper();
        const rawResults = await this._invoke('parse_text', {text});
        // Note: The format of rawResults is not validated
        return this._convertParseTextResults(/** @type {import('mecab').ParseResultRaw} */ (rawResults));
    }

    /**
     * Gets the names of the stored dictionaries.
     * @returns {Promise<string[]>}
     */
    async getDictionaries() {
        await this._setupPortWrapper();
        return /** @type {string[]} */ (await this._invoke('get_dictionaries', {}));
    }

    /**
     * Stores a dictionary from an archive like those the native MeCab component's installer downloads.
     * @param {ArrayBuffer} archive
     * @returns {Promise<string>} The dictionary's name.
     */
    async importDictionary(archive) {
        await this._setupPortWrapper();
        return /** @type {string} */ (await this._invoke('import_dictionary', {archive}));
    }

    /**
     * Removes a stored dictionary.
     * @param {string} name
     */
    async deleteDictionary(name) {
        await this._setupPortWrapper();
        await this._invoke('delete_dictionary', {name});
    }

    // Private

    /**
     * @param {unknown} message
     */
    _onMessage(message) {
        if (typeof message !== 'object' || message === null) { return; }

        const {sequence, data, error} = /** @type {import('core').SerializableObject} */ (message);
        if (typeof sequence !== 'number') { return; }

        const invocation = this._invocations.get(sequence);
        if (typeof invocation === 'undefined') { return; }

        const {resolve, reject, timer} = invocation;
        clearTimeout(timer);
        if (typeof error === 'string') {
            reject(new Error(error));
        } else {
            resolve(data);
        }
        this._invocations.delete(sequence);
    }

    /**
     * @returns {void}
     */
    _onError() {
        if (this._port === null) { return; }
        const error = new Error('MeCab stopped unexpectedly');
        for (const {reject, timer} of this._invocations.values()) {
            clearTimeout(timer);
            reject(error);
        }
        this._clearPort();
    }

    /**
     * @param {string} action
     * @param {{[key: string]: unknown}} params
     * @returns {Promise<unknown>}
     */
    _invoke(action, params) {
        return new Promise((resolve, reject) => {
            if (this._port === null) {
                reject(new Error('Port disconnected'));
                return;
            }

            const sequence = this._sequence++;

            const timer = setTimeout(() => {
                this._invocations.delete(sequence);
                reject(new Error(`MeCab invoke timed out after ${this._timeout}ms`));
            }, this._timeout);

            this._invocations.set(sequence, {resolve, reject, timer});

            this._port.postMessage({action, params, sequence});
        });
    }

    /**
     * @param {import('mecab').ParseResultRaw} rawResults
     * @returns {import('mecab').ParseResult[]}
     */
    _convertParseTextResults(rawResults) {
        /** @typedef {(tok: import('mecab').ParseFragment) => boolean} TokenPredicate */

        /** @type {import('mecab').ParseResult[]} */
        const results = [];
        for (const [name, rawLines] of Object.entries(rawResults)) {
            // Define helper functions based on dictionary type
            /** @type {TokenPredicate} */ let ignoreReading;
            /** @type {TokenPredicate} */ let isNoun;
            /** @type {TokenPredicate} */ let isProperNoun;
            /** @type {TokenPredicate} */ let isCopula;
            /** @type {TokenPredicate} */ let isAuxVerb;
            /** @type {TokenPredicate} */ let isContinuativeForm;
            /** @type {TokenPredicate} */ let isVerbSuffix;
            /** @type {TokenPredicate} */ let isTatteParticle;
            /** @type {TokenPredicate} */ let isBaParticle;
            /** @type {TokenPredicate} */ let isTeDeParticle;
            /** @type {TokenPredicate} */ let isTaDaParticle;
            /** @type {TokenPredicate} */ let isVerb;
            /** @type {TokenPredicate} */ let isVerbNonIndependent;
            /** @type {TokenPredicate} */ let isNounSuffix;
            /** @type {TokenPredicate} */ let isCounter;
            /** @type {TokenPredicate} */ let isNumeral;

            if (name === 'unidic-mecab-translate') {
                // Helper functions for unidic-mecab-translate
                ignoreReading = (tok) => tok.pos1 === 'symbol' && tok.pos2 === 'character';
                isNoun = (tok) => tok.pos1 === 'noun';
                isCopula = (tok) => tok.inflection_type === 'aux|da' || tok.inflection_type === 'aux|desu';
                isAuxVerb = (tok) => (tok.pos1 === 'aux' || tok.pos1 === 'aux-verb') && !isCopula(tok);
                isContinuativeForm = (tok) => tok.inflection_form.startsWith('continuative');
                isVerbSuffix = (tok) => tok.pos1 === 'suffix';
                isTatteParticle = (tok) => tok.pos1 === 'particle' && tok.pos2 === 'conjunctive' && (tok.lemma === 'たって');
                isBaParticle = (tok) => tok.pos1 === 'particle' && tok.pos2 === 'conjunctive' && (tok.term === 'ば');
                isTeDeParticle = (tok) => tok.pos1 === 'particle' && tok.pos2 === 'conjunctive' && tok.lemma === 'て';
                isTaDaParticle = (tok) => isAuxVerb(tok) && (tok.term === 'た' || tok.term === 'だ');
                isVerb = (tok) => tok.pos1 === 'verb' || (tok.pos1 === 'aux' || tok.pos1 === 'aux-verb');
                isVerbNonIndependent = (tok) => isVerb(tok) && tok.pos2 === 'nonindependent?';
                isProperNoun = (tok) => tok.pos1 === 'noun' && tok.pos2 === 'proper';
                isNounSuffix = (tok) => tok.pos1 === 'suffix' && tok.pos2 === 'substantive';
                isCounter = (tok) => tok.pos1 === 'noun' && tok.pos2 === 'common' && tok.pos3 === 'counter?';
                isNumeral = (tok) => tok.pos1 === 'noun' && tok.pos2 === 'numeral';
            } else {
                // Helper functions for ipadic and other dictionaries
                ignoreReading = (tok) => tok.pos1 === '記号' && tok.pos2 === '文字';
                isNoun = (tok) => tok.pos1 === '名詞';
                /** @type {TokenPredicate} */
                const isCopulaIpadic = (tok) => tok.inflection_type === '特殊|だ' || tok.inflection_type === '特殊|デス';
                /** @type {TokenPredicate} */
                const isCopulaUnidic = (tok) => tok.inflection_type === '助動詞-ダ' || tok.inflection_type === '助動詞-デス';
                isCopula = (tok) => isCopulaIpadic(tok) || isCopulaUnidic(tok);
                isAuxVerb = (tok) => tok.pos1 === '助動詞' && !isCopula(tok);
                isContinuativeForm = (tok) => (tok.inflection_form === '連用デ接続' || tok.inflection_form === '連用タ接続' || tok.inflection_form.startsWith('連用形')) && (tok.reading !== 'ない');
                // 待ってるじゃないです : てる is 動詞,非自立,*,*,一段,基本形,てる,テル,テル
                // やられる : れる is 動詞,接尾,*,*,一段,基本形,れる,レル,レル
                /** @type {TokenPredicate} */
                const isVerbSuffixIpadic = (tok) => tok.pos1 === '動詞' && (tok.pos2 === '非自立' || tok.pos2 === '接尾');
                /** @type {TokenPredicate} */
                const isVerbSuffixUnidic = (tok) => tok.pos1 === '接尾辞' && (tok.pos2 === '形容詞的');
                isVerbSuffix = (tok) => isVerbSuffixUnidic(tok) || isVerbSuffixIpadic(tok);
                isTatteParticle = (tok) => tok.pos1 === '助詞' && tok.pos2 === '接続助詞' && (tok.lemma === 'たって');
                isBaParticle = (tok) => tok.pos1 === '助詞' && tok.pos2 === '接続助詞' && (tok.term === 'ば');
                isTeDeParticle = (tok) => tok.pos1 === '助詞' && tok.pos2 === '接続助詞' && (tok.term === 'て' || tok.term === 'で' || tok.term === 'ちゃ'); // cha doesn't have a lemma in ipadic
                isTaDaParticle = (tok) => isAuxVerb(tok) && (tok.term === 'た' || tok.term === 'だ');
                isVerb = (tok) => tok.pos1 === '動詞' || tok.pos1 === '助動詞';
                isVerbNonIndependent = () => true;
                isProperNoun = (tok) => tok.pos1 === '名詞' && tok.pos2 === '固有名詞';
                /** @type {TokenPredicate} */
                const isNounSuffixIpadic = (tok) => tok.pos1 === '動詞' && tok.pos2 === '接尾';
                /** @type {TokenPredicate} */
                const isNounSuffixUnidic = (tok) => tok.pos1 === '接尾辞' && tok.pos2 === '名詞的';
                isNounSuffix = (tok) => isNounSuffixIpadic(tok) || isNounSuffixUnidic(tok);
                isCounter = (tok) => tok.pos1 === '名詞' && tok.pos3.startsWith('助数詞');
                isNumeral = (tok) => tok.pos1 === '名詞' && tok.pos2.startsWith('数');
            }

            /** @type {import('mecab').ParseFragment[][]} */
            const lines = [];
            /** @type {import('mecab').ParseFragment|undefined} */
            let last_standalone_token;

            for (const rawLine of rawLines) {
                /** @type {import('mecab').ParseFragment[]} */
                const line = [];

                for (let {expression: term, reading, source, pos1, pos2, pos3, pos4, inflection_type, inflection_form, lemma, lemma_reading} of rawLine) {
                    if (typeof term !== 'string') { term = ''; }
                    if ((typeof reading !== 'string')) { reading = ''; }
                    if (typeof source !== 'string') { source = ''; }
                    if (typeof pos1 !== 'string') { pos1 = ''; }
                    if (typeof pos2 !== 'string') { pos2 = ''; }
                    if (typeof pos3 !== 'string') { pos3 = ''; }
                    if (typeof pos4 !== 'string') { pos4 = ''; }
                    if (typeof inflection_type !== 'string') { inflection_type = ''; }
                    if (typeof inflection_form !== 'string') { inflection_form = ''; }
                    if (typeof lemma !== 'string') { lemma = ''; }
                    if (typeof lemma_reading !== 'string') { lemma_reading = ''; }

                    /** @type {import('mecab').ParseFragment} */
                    const token = {term, reading, source, pos1, pos2, pos3, pos4, inflection_type, inflection_form, lemma, lemma_reading};

                    if (ignoreReading(token)) {
                        token.reading = '';
                    }

                    let result_token = token;
                    let should_merge;
                    if (line.length > 0 && typeof last_standalone_token !== 'undefined') {
                        const last_result_token = line[line.length - 1];
                        should_merge = (isVerb(last_standalone_token) && (isAuxVerb(token) || (isContinuativeForm(last_standalone_token) && isVerbSuffix(token)) || (isVerbSuffix(token) && isVerbNonIndependent(last_standalone_token)))) ||
                        (isNoun(last_standalone_token) && !isProperNoun(last_standalone_token) && isNounSuffix(token)) ||
                        (isCounter(token) && isNumeral(last_standalone_token)) ||
                        isBaParticle(token) || isTatteParticle(token) ||
                        (isTeDeParticle(token) && isContinuativeForm(last_standalone_token)) ||
                        isTaDaParticle(token); // Allowing more than verbs because it can be adj too, なかった
                        if (should_merge) {
                            line.pop();
                            last_result_token.term = last_result_token.term + token.term;
                            last_result_token.reading = last_result_token.reading + token.reading;
                            last_result_token.source = last_result_token.source + token.source;
                            result_token = last_result_token;
                        }
                    }
                    last_standalone_token = token;
                    line.push(result_token);
                }
                lines.push(line);
            }
            results.push({name, lines});
        }
        return results;
    }

    /**
     * @returns {Promise<void>}
     */
    async _setupPortWrapper() {
        if (!this._enabled) {
            throw new Error('MeCab not enabled');
        }
        if (this._setupPortPromise === null) {
            this._setupPortPromise = this._setupPort();
        }
        try {
            await this._setupPortPromise;
        } catch (e) {
            throw toError(e);
        }
    }

    /**
     * @returns {Promise<void>}
     */
    async _setupPort() {
        /** @type {MessagePort|Worker} */
        let target;
        try {
            target = this._connectWorker !== null ? await this._connectWorker() : new Worker(new URL('mecab-worker-main.js', import.meta.url), {type: 'module'});
        } catch (e) {
            this._setupPortPromise = null;
            throw e;
        }
        this._eventListeners.addEventListener(target, 'message', (/** @type {MessageEvent<unknown>} */ {data}) => this._onMessage(data));
        this._eventListeners.addEventListener(target, 'error', this._onError.bind(this));
        if (target instanceof MessagePort) {
            target.start();
            this._port = {
                postMessage: (message) => target.postMessage(message),
                disconnect: () => target.close(),
            };
        } else {
            this._port = {
                postMessage: (message) => target.postMessage(message),
                disconnect: () => target.terminate(),
            };
        }
    }

    /**
     * @returns {void}
     */
    _clearPort() {
        if (this._port !== null) {
            this._port.disconnect();
            this._port = null;
        }
        this._invocations.clear();
        this._eventListeners.removeAllEventListeners();
        this._sequence = 0;
        this._setupPortPromise = null;
    }
}
