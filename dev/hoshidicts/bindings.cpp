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
#include <fcntl.h>
#include <unistd.h>

#include <cstring>
#include <exception>
#include <filesystem>
#include <fstream>
#include <glaze/glaze.hpp>
#include <hoshidicts/importer.hpp>
#include <hoshidicts/query.hpp>
#include <string>
#include <tuple>
#include <unordered_map>
#include <vector>

#include "image_size.hpp"
#include "rows.hpp"

namespace yomitan {
DictionaryQuery g_query;
std::string g_out;
std::vector<uint8_t> g_media;

// A tag bank row: name, category, order, notes and score.
using TagRow = std::tuple<std::string, std::string, double, std::string, double>;

// An image a glossary shows, with the first term row that shows it.
struct ReportImage {
  std::string path;
  std::string expression;
  std::string reading;
  // The size its header gives, or 0 when the header does not settle it (see
  // image_size::read) or the archive does not hold the image.
  uint32_t width = 0;
  uint32_t height = 0;
};

struct ImportReport {
  bool success = false;
  std::string error;
  SummaryCounts counts;
  std::vector<TagRow> tags;
  std::string styles;
  std::vector<ReportImage> images;
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

// Reads the size of each of `images` from its header in the media.bin of the
// dictionary at `directory`: from the start of its file, or from all of it when
// the start does not settle the size. media.idx is a u32 count and the offset
// of each record in media.bin, a record a u16 path length, the path, a u32 size
// and the file (hoshidicts' write_media in src/importer.cpp).
void read_image_sizes(const std::filesystem::path& directory, std::vector<ReportImage>& images) {
  // Most headers fit, and more would mostly be read for nothing.
  constexpr size_t start_bytes = 4096;
  if (images.empty()) {
    return;
  }
  std::ifstream index_file(directory / "media.idx", std::ios::binary);
  const std::string index(std::istreambuf_iterator<char>(index_file), {});
  const int fd = ::open((directory / "media.bin").c_str(), O_RDONLY);
  if (index.size() < sizeof(uint32_t) || fd < 0) {
    if (fd >= 0) {
      ::close(fd);
    }
    return;
  }
  std::unordered_map<std::string_view, ReportImage*> wanted;
  for (auto& image : images) {
    wanted.emplace(image.path, &image);
  }
  uint32_t count = 0;
  std::memcpy(&count, index.data(), sizeof(count));
  count = std::min<uint32_t>(count, (index.size() - sizeof(uint32_t)) / sizeof(uint64_t));
  std::string buffer;
  const auto read_at = [&](uint64_t offset, size_t length) {
    buffer.resize(length);
    const ssize_t n = ::pread(fd, buffer.data(), length, static_cast<off_t>(offset));
    buffer.resize(n > 0 ? static_cast<size_t>(n) : 0);
  };
  for (uint32_t i = 0; i < count; ++i) {
    uint64_t offset = 0;
    std::memcpy(&offset, index.data() + sizeof(uint32_t) + i * sizeof(uint64_t), sizeof(offset));
    read_at(offset, start_bytes);
    if (buffer.size() < sizeof(uint16_t)) {
      continue;
    }
    uint16_t path_length = 0;
    std::memcpy(&path_length, buffer.data(), sizeof(path_length));
    const size_t header = sizeof(uint16_t) + path_length + sizeof(uint32_t);
    if (buffer.size() < header) {
      read_at(offset, header + start_bytes);
      if (buffer.size() < header) {
        continue;
      }
    }
    const auto it = wanted.find(std::string_view(buffer).substr(sizeof(uint16_t), path_length));
    if (it == wanted.end()) {
      continue;
    }
    ReportImage& image = *it->second;
    uint32_t size = 0;
    std::memcpy(&size, buffer.data() + sizeof(uint16_t) + path_length, sizeof(size));
    auto image_size = image_size::read(std::string_view(buffer).substr(header, size));
    if (!image_size && buffer.size() < header + size) {
      read_at(offset, header + size);
      image_size = image_size::read(std::string_view(buffer).substr(header, size));
    }
    if (image_size) {
      image.width = image_size->width;
      image.height = image_size->height;
    }
  }
  ::close(fd);
}

// The loaded dictionaries of a kind.
Dictionaries dictionaries(DictionaryKind kind) { return QueryAccess::dictionaries(g_query, kind); }

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
      for (auto& image : result.images) {
        report.images.push_back({std::move(image.path), std::move(image.expression), std::move(image.reading)});
      }
      read_image_sizes(std::filesystem::path(output_directory) / dictionary_importer::folder_name(result.title),
                       report.images);
    }
  } catch (const std::exception& e) {
    report.error = e.what();
  }
  return write(report);
}

// Loads the dictionary at `path` for every kind of query. Its entries and its
// hash index are read from the files on demand, rather than copied into
// memory, and the lookups say what they will read ahead (prefetch_rows and the
// like).
EMSCRIPTEN_KEEPALIVE int yh_add(const char* path) {
  const auto storage = DictionaryStorage::Paged;
  const auto index_storage = DictionaryIndexStorage::Paged;
  try {
    return g_query.add_term_dict(path, storage, index_storage) && g_query.add_freq_dict(path, storage, index_storage) &&
                   g_query.add_kanji_dict(path, storage, index_storage)
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
  const Dictionaries terms = dictionaries(DictionaryKind::Term);
  const Dictionaries* lists[] = {&terms};
  return each_key<std::string>(
      keys_json, [&](const std::string& key) { return query_rows(terms, key); },
      [&](const std::vector<std::string>& keys) { prefetch_records(lists, keys); });
}

// [["dictionary", sequence], ...] -> [[TermRow, ...], ...], without glossaries.
EMSCRIPTEN_KEEPALIVE const char* yh_find_terms_by_sequence(const char* items_json) {
  const Dictionaries terms = dictionaries(DictionaryKind::Term);
  return each_key<std::tuple<std::string, int64_t>>(items_json, [&](const auto& item) {
    return query_sequence_rows(terms, std::get<0>(item), std::get<1>(item));
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
    const Dictionaries terms = dictionaries(DictionaryKind::Term);
    prefetch_glossaries(terms, items);
    g_out.assign(1, '[');
    for (const auto& [dictionary, offset] : items) {
      if (g_out.size() > 1) {
        g_out += ',';
      }
      auto glossary = query_glossary(terms, dictionary, offset);
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
  const Dictionaries frequencies = dictionaries(DictionaryKind::Frequency);
  const Dictionaries pitches = dictionaries(DictionaryKind::Pitch);
  const Dictionaries* lists[] = {&frequencies, &pitches};
  return each_key<std::string>(
      keys_json, [&](const std::string& key) { return query_meta_rows(lists, key); },
      [&](const std::vector<std::string>& keys) { prefetch_records(lists, keys); });
}

// ["character", ...] -> [[KanjiRow, ...], ...]
EMSCRIPTEN_KEEPALIVE const char* yh_find_kanji(const char* keys_json) {
  const Dictionaries kanji = dictionaries(DictionaryKind::Kanji);
  const Dictionaries* lists[] = {&kanji};
  return each_key<std::string>(
      keys_json, [&](const std::string& key) { return query_kanji_rows(kanji, key); },
      [&](const std::vector<std::string>& keys) { prefetch_records(lists, keys); });
}

// ["character", ...] -> [[MetaRow, ...], ...]
EMSCRIPTEN_KEEPALIVE const char* yh_find_kanji_meta(const char* keys_json) {
  const Dictionaries frequencies = dictionaries(DictionaryKind::Frequency);
  const Dictionaries* lists[] = {&frequencies};
  return each_key<std::string>(
      keys_json, [&](const std::string& key) { return query_kanji_meta_rows(frequencies, key); },
      [&](const std::vector<std::string>& keys) { prefetch_records(lists, keys); });
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
