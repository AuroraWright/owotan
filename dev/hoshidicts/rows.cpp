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

#include "rows.hpp"

#include <algorithm>
#include <cstdint>
#include <exception>
#include <string_view>
#include <utility>

#include "blob_file.hpp"
#include "hash/hash.hpp"
#include "json/yomitan_parser.hpp"

namespace yomitan {
namespace {
// Enough of a term record for query_rows and query_glossary to read it whole,
// or the fields before its glossary, for most records.
constexpr size_t term_record_advice_bytes = 512;

// The record types hoshidicts writes.
constexpr uint8_t term_record = 0;
constexpr uint8_t term_meta_record = 1;
constexpr uint8_t kanji_record = 2;
constexpr uint8_t kanji_meta_record = 3;

// Calls `visit` with each record the index of `key` lists in `dict`, opened.
template <typename Visit>
void each_record(const DictionaryFiles& dict, std::string_view key, BlobPins& pins, Visit&& visit) {
  const uint64_t offset_addr = (*dict.table)(key);
  if (offset_addr == 0) {
    return;
  }
  visit_blobs(*dict.blobs, pins, [&](auto open) {
    auto index = open(offset_addr);
    const auto count = read_value<uint32_t>(index);
    for (uint32_t i = 0; i < count; i++) {
      const auto offset = read_value<uint64_t>(index);
      auto record = open(offset);
      visit(record, offset);
    }
  });
}

// Appends the term record `blob`, at `offset`, to `rows` when `accept` takes
// its expression and reading, and returns whether it did. The record's layout
// is in hoshidicts' src/importer.cpp (process_term_bank).
template <typename Cursor, typename Accept>
bool read_term_row(Cursor& blob, uint64_t offset, const std::string& dict_name, Accept&& accept,
                   std::vector<TermRow>& rows) {
  if (read_value<uint8_t>(blob) != term_record) {
    return false;
  }
  std::string_view expr = blob.str(read_value<uint16_t>(blob));
  std::string_view reading = blob.str(read_value<uint16_t>(blob));
  if (!accept(expr, reading)) {
    return false;
  }
  // The glossary's offset and size, which query_glossary reads.
  blob.skip(sizeof(uint64_t) + sizeof(uint32_t));
  TermRow& row = rows.emplace_back();
  row.dict_name = dict_name;
  row.expression = expr;
  row.reading = reading;
  row.offset = offset;
  row.definition_tags = blob.str(read_value<uint8_t>(blob));
  row.rules = blob.str(read_value<uint8_t>(blob));
  row.term_tags = blob.str(read_value<uint8_t>(blob));
  // The form-of slot: the flag, an entry with an empty formOf, then the
  // references (hoshidicts' src/json/form_of.hpp).
  const auto entry_count = read_value<uint32_t>(blob);
  for (uint32_t r = 0; r < entry_count; r++) {
    std::string_view form_of = blob.str(read_value<uint32_t>(blob));
    const auto rule_count = read_value<uint32_t>(blob);
    if (form_of.empty()) {
      for (uint32_t j = 0; j < rule_count; j++) {
        blob.skip(read_value<uint32_t>(blob));
      }
      continue;
    }
    TermRedirect& redirect = row.redirects.emplace_back();
    redirect.form_of = form_of;
    for (uint32_t j = 0; j < rule_count; j++) {
      redirect.rules.emplace_back(blob.str(read_value<uint32_t>(blob)));
    }
  }
  row.score = read_value<double>(blob);
  row.has_definitions = read_value<uint8_t>(blob) != 0;
  row.sequence = read_value<int64_t>(blob);
  return true;
}

const DictionaryFiles* find_dictionary(const Dictionaries& dicts, const std::string& name) {
  const auto it = std::ranges::find_if(dicts, [&](const DictionaryFiles& dict) { return *dict.name == name; });
  return it == dicts.end() ? nullptr : &*it;
}
}  // namespace

std::vector<TermRow> query_rows(const Dictionaries& terms, const std::string& key) {
  std::vector<TermRow> rows;
  BlobPins pins;
  for (const auto& dict : terms) {
    if (!dict.yomitan_rows) {
      continue;
    }
    each_record(dict, key, pins, [&](auto& record, uint64_t offset) {
      if (read_term_row(
              record, offset, *dict.name,
              [&](std::string_view expr, std::string_view reading) { return expr == key || reading == key; }, rows)) {
        TermRow& row = rows.back();
        row.reading_match = row.expression != key;
      }
    });
  }
  return rows;
}

std::vector<TermRow> query_sequence_rows(const Dictionaries& terms, const std::string& dict_name, int64_t sequence) {
  std::vector<TermRow> rows;
  const auto* dict = find_dictionary(terms, dict_name);
  if (dict == nullptr || !dict->yomitan_rows) {
    return rows;
  }
  BlobPins pins;
  each_record(*dict, yomitan_parser::sequence_key(sequence), pins, [&](auto& record, uint64_t offset) {
    // The key's hash may be an expression's too.
    if (read_term_row(record, offset, *dict->name, [](std::string_view, std::string_view) { return true; }, rows) &&
        rows.back().sequence != sequence) {
      rows.pop_back();
    }
  });
  return rows;
}

std::optional<std::string> query_glossary(const Dictionaries& terms, const std::string& dict_name, uint64_t offset) {
  const auto* dict = find_dictionary(terms, dict_name);
  if (dict == nullptr || offset >= dict->blobs->size()) {
    return std::nullopt;
  }
  BlobPins pins;
  std::optional<std::string> glossary;
  visit_blobs(*dict->blobs, pins, [&](auto open) {
    auto record = open(offset);
    if (read_value<uint8_t>(record) != term_record) {
      return;
    }
    record.skip(read_value<uint16_t>(record));
    record.skip(read_value<uint16_t>(record));
    const auto glossary_offset = read_value<uint64_t>(record);
    const auto glossary_size = read_value<uint32_t>(record);
    glossary = QueryAccess::decompress_glossary(*dict, glossary_offset, glossary_size, pins);
  });
  return glossary;
}

std::vector<MetaRow> query_meta_rows(std::span<const Dictionaries* const> lists, const std::string& key) {
  std::vector<MetaRow> rows;
  BlobPins pins;
  std::vector<const void*> seen;
  for (const auto* list : lists) {
    for (const auto& dict : *list) {
      if (std::ranges::find(seen, dict.data) != seen.end()) {
        continue;
      }
      seen.push_back(dict.data);
      each_record(dict, key, pins, [&](auto& record, uint64_t) {
        if (read_value<uint8_t>(record) != term_meta_record) {
          return;
        }
        std::string_view expr = record.str(read_value<uint16_t>(record));
        if (expr != key) {
          return;
        }
        std::string_view mode = record.str(read_value<uint8_t>(record));
        std::string_view data = record.str(read_value<uint32_t>(record));
        rows.push_back(MetaRow{.dict_name = *dict.name,
                               .expression = std::string(expr),
                               .mode = std::string(mode),
                               .data = std::string(data)});
      });
    }
  }
  return rows;
}

std::vector<KanjiRow> query_kanji_rows(const Dictionaries& kanji, const std::string& character) {
  std::vector<KanjiRow> rows;
  BlobPins pins;
  for (const auto& dict : kanji) {
    each_record(dict, character, pins, [&](auto& record, uint64_t) {
      if (read_value<uint8_t>(record) != kanji_record) {
        return;
      }
      if (record.str(read_value<uint8_t>(record)) != character) {
        return;
      }
      KanjiRow& row = rows.emplace_back();
      row.dict_name = *dict.name;
      row.character = character;
      row.onyomi = record.str(read_value<uint16_t>(record));
      row.kunyomi = record.str(read_value<uint16_t>(record));
      row.tags = record.str(read_value<uint16_t>(record));
      const auto meaning_count = read_value<uint16_t>(record);
      for (uint16_t j = 0; j < meaning_count; j++) {
        row.meanings.emplace_back(record.str(read_value<uint16_t>(record)));
      }
      const auto stat_count = read_value<uint16_t>(record);
      for (uint16_t j = 0; j < stat_count; j++) {
        std::string name(record.str(read_value<uint16_t>(record)));
        row.stats.emplace(std::move(name), record.str(read_value<uint16_t>(record)));
      }
    });
  }
  return rows;
}

std::vector<MetaRow> query_kanji_meta_rows(const Dictionaries& frequencies, const std::string& character) {
  std::vector<MetaRow> rows;
  BlobPins pins;
  for (const auto& dict : frequencies) {
    each_record(dict, character, pins, [&](auto& record, uint64_t) {
      if (read_value<uint8_t>(record) != kanji_meta_record) {
        return;
      }
      if (record.str(read_value<uint16_t>(record)) != character) {
        return;
      }
      std::string_view mode = record.str(read_value<uint8_t>(record));
      std::string_view data = record.str(read_value<uint32_t>(record));
      rows.push_back(MetaRow{.dict_name = *dict.name,
                             .expression = character,
                             .mode = std::string(mode),
                             .data = std::string(data)});
    });
  }
  return rows;
}

void prefetch_records(std::span<const Dictionaries* const> lists, std::span<const std::string> keys) {
  // A dictionary loaded as several kinds shares its files.
  std::vector<const DictionaryFiles*> dicts;
  for (const auto* list : lists) {
    for (const auto& dict : *list) {
      if (dict.blobs->paged() &&
          std::ranges::none_of(dicts, [&](const DictionaryFiles* other) { return other->data == dict.data; })) {
        dicts.push_back(&dict);
      }
    }
  }
  // Only a hint, so a file that cannot be read is left to the query.
  try {
    for (const auto& key : keys) {
      for (const auto* dict : dicts) {
        dict->table->advise(key);
      }
    }
    // The index record of each key in each dictionary: a count, then the
    // offsets of the records.
    std::vector<std::pair<const DictionaryFiles*, uint64_t>> indexes;
    for (const auto& key : keys) {
      for (const auto* dict : dicts) {
        const uint64_t offset = (*dict->table)(key);
        if (offset != 0) {
          dict->blobs->advise(offset, sizeof(uint32_t));
          indexes.emplace_back(dict, offset);
        }
      }
    }
    BlobPins pins;
    std::vector<uint32_t> counts;
    counts.reserve(indexes.size());
    for (const auto& [dict, offset] : indexes) {
      BlobCursor index(*dict->blobs, offset, pins);
      const auto count = read_value<uint32_t>(index);
      counts.push_back(count);
      dict->blobs->advise(offset + sizeof(uint32_t), count * sizeof(uint64_t));
    }
    for (size_t i = 0; i < indexes.size(); i++) {
      const auto& [dict, offset] = indexes[i];
      BlobCursor index(*dict->blobs, offset + sizeof(uint32_t), pins);
      for (uint32_t j = 0; j < counts[i]; j++) {
        dict->blobs->advise(read_value<uint64_t>(index), term_record_advice_bytes);
      }
    }
  } catch (const std::exception&) {
  }
}

void prefetch_glossaries(const Dictionaries& terms, std::span<const std::tuple<std::string, uint64_t>> items) {
  try {
    std::vector<std::pair<const DictionaryFiles*, uint64_t>> records;
    for (const auto& [dict_name, offset] : items) {
      const auto* dict = find_dictionary(terms, dict_name);
      if (dict != nullptr && dict->blobs->paged() && offset < dict->blobs->size()) {
        dict->blobs->advise(offset, term_record_advice_bytes);
        records.emplace_back(dict, offset);
      }
    }
    BlobPins pins;
    for (const auto& [dict, offset] : records) {
      BlobCursor record(*dict->blobs, offset, pins);
      if (read_value<uint8_t>(record) != term_record) {
        continue;
      }
      record.skip(read_value<uint16_t>(record));
      record.skip(read_value<uint16_t>(record));
      const auto glossary_offset = read_value<uint64_t>(record);
      const auto glossary_size = read_value<uint32_t>(record);
      dict->blobs->advise(glossary_offset, glossary_size);
    }
  } catch (const std::exception&) {
  }
}
}  // namespace yomitan
