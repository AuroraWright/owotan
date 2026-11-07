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

// The hoshidicts calls Yomitan's dictionary database makes. Requests and
// results are JSON; a result string stays valid until the next call.

#include <emscripten/emscripten.h>

#include <exception>
#include <glaze/glaze.hpp>
#include <hoshidicts/importer.hpp>
#include <hoshidicts/query.hpp>
#include <string>
#include <tuple>
#include <vector>

namespace yomitan {
DictionaryQuery g_query;
std::string g_out;
std::vector<uint8_t> g_media;

// A tag bank row: name, category, order, notes and score.
using TagRow = std::tuple<std::string, std::string, double, std::string, double>;

struct ImportReport {
  bool success = false;
  std::string error;
  SummaryCounts counts;
  std::vector<TagRow> tags;
  std::string styles;
  std::vector<ImportImage> images;
};

struct Error {
  std::string error;
};

template <typename T>
const char* write(const T& value) {
  g_out.clear();
  if (glz::write_json(value, g_out)) {
    g_out = R"({"error":"could not serialize the result"})";
  }
  return g_out.c_str();
}

const char* write_error(const char* message) { return write(Error{message}); }

template <typename T>
bool read(T& value, const char* json) {
  return !glz::read<glz::opts{.error_on_unknown_keys = false}>(value, std::string_view{json});
}

// Runs `get` for each key of the JSON array `keys_json`: [[result, ...], ...],
// after `prepare` with them all.
template <typename Key, typename Get, typename Prepare = void (*)(const std::vector<Key>&)>
const char* each_key(const char* keys_json, Get&& get, Prepare&& prepare = [](const std::vector<Key>&) {}) {
  std::vector<Key> keys;
  if (!read(keys, keys_json)) {
    return write_error("invalid request");
  }
  try {
    prepare(keys);
    std::vector<decltype(get(keys.front()))> out;
    out.reserve(keys.size());
    for (const auto& key : keys) {
      out.push_back(get(key));
    }
    return write(out);
  } catch (const std::exception& e) {
    return write_error(e.what());
  }
}
}  // namespace yomitan

using namespace yomitan;

extern "C" {
// Imports the archive at `archive_path` into a new directory under `output_directory`.
EMSCRIPTEN_KEEPALIVE const char* yh_import(const char* archive_path, const char* output_directory) {
  ImportReport report;
  try {
    auto result = dictionary_importer::import(archive_path, output_directory);
    report.success = result.success;
    report.error = result.error;
    if (result.success) {
      report.counts = std::move(result.summary.counts);
      for (auto& tag : result.summary.tags) {
        report.tags.emplace_back(std::move(tag.name), std::move(tag.category), tag.order, std::move(tag.notes), tag.score);
      }
      report.styles = std::move(result.summary.styles);
      report.images = std::move(result.images);
    }
  } catch (const std::exception& e) {
    report.error = e.what();
  }
  return write(report);
}

// Loads the dictionary at `path` for every kind of query. Its entries are read
// from the files on demand, rather than copied into memory.
EMSCRIPTEN_KEEPALIVE int yh_add(const char* path) {
  const auto storage = DictionaryStorage::Paged;
  try {
    return g_query.add_term_dict(path, storage) && g_query.add_freq_dict(path, storage) &&
                   g_query.add_kanji_dict(path, storage)
               ? 1
               : 0;
  } catch (const std::exception&) {
    g_query.remove_dict(path);
    return 0;
  }
}

EMSCRIPTEN_KEEPALIVE void yh_remove(const char* path) { g_query.remove_dict(path); }

// ["key", ...] -> [[TermRow, ...], ...], without glossaries.
EMSCRIPTEN_KEEPALIVE const char* yh_find_terms(const char* keys_json) {
  return each_key<std::string>(
      keys_json, [](const std::string& key) { return g_query.query_rows(key); },
      [](const std::vector<std::string>& keys) { g_query.prefetch_rows(keys); });
}

// [["dictionary", sequence], ...] -> [[TermRow, ...], ...], without glossaries.
EMSCRIPTEN_KEEPALIVE const char* yh_find_terms_by_sequence(const char* items_json) {
  return each_key<std::tuple<std::string, int64_t>>(items_json, [](const auto& item) {
    return g_query.query_sequence_rows(std::get<0>(item), std::get<1>(item));
  });
}

// [["dictionary", offset], ...] -> [glossary, ...], each the stored JSON as it
// is, or null for a row that is not there.
EMSCRIPTEN_KEEPALIVE const char* yh_glossaries(const char* items_json) {
  std::vector<std::tuple<std::string, uint64_t>> items;
  if (!read(items, items_json)) {
    return write_error("invalid request");
  }
  try {
    g_query.prefetch_glossaries(items);
    g_out.assign(1, '[');
    for (const auto& [dictionary, offset] : items) {
      if (g_out.size() > 1) {
        g_out += ',';
      }
      auto glossary = g_query.query_glossary(dictionary, offset);
      g_out += glossary && !glossary->empty() ? *glossary : "null";
    }
    g_out += ']';
    return g_out.c_str();
  } catch (const std::exception& e) {
    return write_error(e.what());
  }
}

// ["key", ...] -> [[MetaRow, ...], ...]
EMSCRIPTEN_KEEPALIVE const char* yh_find_term_meta(const char* keys_json) {
  return each_key<std::string>(keys_json, [](const std::string& key) { return g_query.query_meta_rows(key); });
}

// ["character", ...] -> [[KanjiRow, ...], ...]
EMSCRIPTEN_KEEPALIVE const char* yh_find_kanji(const char* keys_json) {
  return each_key<std::string>(keys_json, [](const std::string& key) { return g_query.query_kanji_rows(key); });
}

// ["character", ...] -> [[MetaRow, ...], ...]
EMSCRIPTEN_KEEPALIVE const char* yh_find_kanji_meta(const char* keys_json) {
  return each_key<std::string>(keys_json, [](const std::string& key) { return g_query.query_kanji_meta_rows(key); });
}

// Reads a media file of a loaded dictionary; yh_media_size is its length, -1
// when it is not there.
EMSCRIPTEN_KEEPALIVE const uint8_t* yh_media(const char* dictionary, const char* path) {
  try {
    g_query.read_media_file(dictionary, path, g_media);
  } catch (const std::exception&) {
    g_media.clear();
  }
  return g_media.empty() ? nullptr : g_media.data();
}

EMSCRIPTEN_KEEPALIVE int yh_media_size() { return g_media.empty() ? -1 : static_cast<int>(g_media.size()); }
}
