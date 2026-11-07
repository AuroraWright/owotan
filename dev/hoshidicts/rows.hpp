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

// The rows of Yomitan's dictionary database, read from the records of the
// dictionaries hoshidicts has loaded (QueryAccess::dictionaries), and the hints
// that tell their paged files what those reads will need.

#pragma once

#include <hoshidicts/query.hpp>
#include <map>
#include <optional>
#include <span>
#include <string>
#include <tuple>
#include <vector>

#include "query_internal.hpp"

namespace yomitan {
struct TermRedirect {
  std::string form_of;
  std::vector<std::string> rules;
};

// One term-bank row, without its glossary, which query_glossary reads. `offset`
// identifies the row within its dictionary.
struct TermRow {
  std::string dict_name;
  std::string expression;
  std::string reading;
  std::string definition_tags;
  std::string rules;
  std::string term_tags;
  double score = 0;
  // The form-of references of its definitions.
  std::vector<TermRedirect> redirects;
  // Whether it has a definition that is not an array, which Yomitan shows.
  bool has_definitions = false;
  // The row's sequence; -1 when it has none.
  int64_t sequence = -1;
  uint64_t offset = 0;
  bool reading_match = false;
};

// One kanji_bank row.
struct KanjiRow {
  std::string dict_name;
  std::string character;
  std::string onyomi;
  std::string kunyomi;
  std::string tags;
  std::vector<std::string> meanings;
  std::map<std::string, std::string> stats;
};

// One term_meta_bank or kanji_meta_bank row with its data left as JSON.
struct MetaRow {
  std::string dict_name;
  std::string expression;
  std::string mode;
  std::string data;
};

using Dictionaries = std::vector<DictionaryFiles>;

// The rows whose expression or reading is `key`, of the term dictionaries
// imported for Yomitan (.hoshidicts_yomitan_1).
std::vector<TermRow> query_rows(const Dictionaries& terms, const std::string& key);
// The rows the sequenced term dictionary `dict_name` files under `sequence`.
std::vector<TermRow> query_sequence_rows(const Dictionaries& terms, const std::string& dict_name, int64_t sequence);
std::optional<std::string> query_glossary(const Dictionaries& terms, const std::string& dict_name, uint64_t offset);
// The term_meta_bank rows of `key`, of the frequency and pitch dictionaries.
std::vector<MetaRow> query_meta_rows(std::span<const Dictionaries* const> lists, const std::string& key);
std::vector<KanjiRow> query_kanji_rows(const Dictionaries& kanji, const std::string& character);
std::vector<MetaRow> query_kanji_meta_rows(const Dictionaries& frequencies, const std::string& character);

// Tell the paged files of the dictionaries what the queries above of each of
// `keys` will read, a level of records at a time, as each level is found in the
// one before it: the hash table slots, the index records, then the records. A
// file system that reads in batches can then read each level at once, rather
// than record by record.
void prefetch_records(std::span<const Dictionaries* const> lists, std::span<const std::string> keys);
// The same for query_glossary of each item.
void prefetch_glossaries(const Dictionaries& terms, std::span<const std::tuple<std::string, uint64_t>> items);
}  // namespace yomitan
