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

#include "image_size.hpp"

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string_view>
#include <vector>

namespace {
uint32_t byte(std::string_view data, size_t at) { return static_cast<uint8_t>(data[at]); }

uint32_t be16(std::string_view data, size_t at) { return (byte(data, at) << 8) | byte(data, at + 1); }

uint32_t be32(std::string_view data, size_t at) { return (be16(data, at) << 16) | be16(data, at + 2); }

uint32_t le16(std::string_view data, size_t at) { return byte(data, at) | (byte(data, at + 1) << 8); }

uint32_t le24(std::string_view data, size_t at) { return le16(data, at) | (byte(data, at + 2) << 16); }

uint32_t le32(std::string_view data, size_t at) { return le16(data, at) | (le16(data, at + 2) << 16); }

std::optional<ImageSize> sized(uint32_t width, uint32_t height) {
  if (width == 0 || height == 0) {
    return std::nullopt;
  }
  return ImageSize{width, height};
}

std::optional<ImageSize> read_png(std::string_view data) {
  // The IHDR chunk comes first. An eXIf chunk before the image data may rotate it.
  if (data.size() < 24 || data.substr(12, 4) != "IHDR") {
    return std::nullopt;
  }
  const uint32_t width = be32(data, 16);
  const uint32_t height = be32(data, 20);
  // Without the image data, the start of a file was given that may end before
  // an eXIf chunk.
  for (size_t at = 8; at + 8 <= data.size();) {
    const std::string_view type = data.substr(at + 4, 4);
    if (type == "eXIf") {
      return std::nullopt;
    }
    if (type == "IDAT") {
      return sized(width, height);
    }
    at += 12 + static_cast<size_t>(be32(data, at));
  }
  return std::nullopt;
}

std::optional<ImageSize> read_gif(std::string_view data) {
  if (data.size() < 10) {
    return std::nullopt;
  }
  return sized(le16(data, 6), le16(data, 8));
}

// The orientation that an Exif block's TIFF data records in its first image
// file directory (tag 0x0112), 1 when it records none; empty when the data
// does not parse.
std::optional<uint32_t> read_exif_orientation(std::string_view tiff) {
  if (tiff.size() < 8) {
    return std::nullopt;
  }
  bool little = false;
  if (tiff.starts_with("II")) {
    little = true;
  } else if (!tiff.starts_with("MM")) {
    return std::nullopt;
  }
  const auto u16 = [&](size_t at) { return little ? le16(tiff, at) : be16(tiff, at); };
  const auto u32 = [&](size_t at) { return little ? le32(tiff, at) : be32(tiff, at); };
  if (u16(2) != 42) {
    return std::nullopt;
  }
  const size_t directory = u32(4);
  if (directory > tiff.size() || tiff.size() - directory < 2) {
    return std::nullopt;
  }
  const size_t count = u16(directory);
  for (size_t i = 0; i < count; ++i) {
    const size_t entry = directory + 2 + 12 * i;
    if (entry > tiff.size() || tiff.size() - entry < 12) {
      return std::nullopt;
    }
    if (u16(entry) == 0x0112) {
      // A SHORT, which is in the first two bytes of the value field.
      return u16(entry + 8);
    }
  }
  return 1;
}

std::optional<ImageSize> read_jpeg(std::string_view data) {
  // Orientations 5 to 8 turn the image a quarter, which browsers apply.
  bool turned = false;
  for (size_t at = 2; at + 4 <= data.size();) {
    if (byte(data, at) != 0xFF) {
      return std::nullopt;
    }
    const uint32_t marker = byte(data, at + 1);
    if (marker == 0xFF) {
      ++at;
      continue;
    }
    if (marker == 0x01 || (marker >= 0xD0 && marker <= 0xD8)) {
      at += 2;
      continue;
    }
    const size_t length = be16(data, at + 2);
    if (length < 2) {
      return std::nullopt;
    }
    if (marker == 0xE1 && data.substr(at + 4, 6) == std::string_view("Exif\0\0", 6)) {
      // The block's length counts its own two bytes and the six of "Exif\0\0".
      if (length < 8 || at + 2 + length > data.size()) {
        return std::nullopt;
      }
      const auto orientation = read_exif_orientation(data.substr(at + 10, length - 8));
      if (!orientation || *orientation < 1 || *orientation > 8) {
        return std::nullopt;
      }
      turned = *orientation >= 5;
    }
    const bool frame = marker >= 0xC0 && marker <= 0xCF && marker != 0xC4 && marker != 0xC8 && marker != 0xCC;
    if (frame) {
      if (at + 9 > data.size()) {
        return std::nullopt;
      }
      return turned ? sized(be16(data, at + 5), be16(data, at + 7)) : sized(be16(data, at + 7), be16(data, at + 5));
    }
    at += 2 + length;
  }
  return std::nullopt;
}

std::optional<ImageSize> read_webp(std::string_view data) {
  if (data.size() < 30 || data.substr(8, 4) != "WEBP") {
    return std::nullopt;
  }
  const std::string_view chunk = data.substr(12, 4);
  if (chunk == "VP8 ") {
    if (byte(data, 23) != 0x9D || byte(data, 24) != 0x01 || byte(data, 25) != 0x2A) {
      return std::nullopt;
    }
    return sized(le16(data, 26) & 0x3FFF, le16(data, 28) & 0x3FFF);
  }
  if (chunk == "VP8L") {
    if (byte(data, 20) != 0x2F) {
      return std::nullopt;
    }
    const uint32_t bits = le32(data, 21);
    return sized((bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1);
  }
  if (chunk == "VP8X") {
    constexpr uint32_t exif_flag = 0x08;
    if ((byte(data, 20) & exif_flag) != 0) {
      return std::nullopt;
    }
    return sized(le24(data, 24) + 1, le24(data, 27) + 1);
  }
  return std::nullopt;
}

std::optional<ImageSize> read_bmp(std::string_view data) {
  if (data.size() < 26) {
    return std::nullopt;
  }
  if (le32(data, 14) == 12) {
    return sized(le16(data, 18), le16(data, 20));
  }
  const auto height = static_cast<int32_t>(le32(data, 22));
  return sized(le32(data, 18), static_cast<uint32_t>(height < 0 ? -static_cast<int64_t>(height) : height));
}

// An ISOBMFF box: its type and contents.
struct Box {
  std::string_view type;
  std::string_view body;
};

std::vector<Box> read_boxes(std::string_view data) {
  std::vector<Box> boxes;
  for (size_t at = 0; at + 8 <= data.size();) {
    uint64_t size = be32(data, at);
    size_t header = 8;
    if (size == 1) {
      if (at + 16 > data.size()) {
        break;
      }
      size = (static_cast<uint64_t>(be32(data, at + 8)) << 32) | be32(data, at + 12);
      header = 16;
    } else if (size == 0) {
      size = data.size() - at;
    }
    if (size < header || size > data.size() - at) {
      break;
    }
    boxes.push_back({data.substr(at + 4, 4), data.substr(at + header, static_cast<size_t>(size) - header)});
    at += static_cast<size_t>(size);
  }
  return boxes;
}

const Box* find_box(const std::vector<Box>& boxes, std::string_view type) {
  for (const auto& box : boxes) {
    if (box.type == type) {
      return &box;
    }
  }
  return nullptr;
}

// The primary item's ispe, the image's size, unless another of its properties
// changes the shown size.
std::optional<ImageSize> read_avif(std::string_view data) {
  const auto top = read_boxes(data);
  const Box* meta = find_box(top, "meta");
  if (meta == nullptr || meta->body.size() < 4) {
    return std::nullopt;
  }
  const auto meta_boxes = read_boxes(meta->body.substr(4));
  const Box* pitm = find_box(meta_boxes, "pitm");
  const Box* iprp = find_box(meta_boxes, "iprp");
  if (pitm == nullptr || iprp == nullptr || pitm->body.size() < 6) {
    return std::nullopt;
  }
  const bool wide_item = byte(pitm->body, 0) != 0;
  if (wide_item && pitm->body.size() < 8) {
    return std::nullopt;
  }
  const uint32_t primary = wide_item ? be32(pitm->body, 4) : be16(pitm->body, 4);
  const auto iprp_boxes = read_boxes(iprp->body);
  const Box* ipco = find_box(iprp_boxes, "ipco");
  if (ipco == nullptr) {
    return std::nullopt;
  }
  const auto properties = read_boxes(ipco->body);

  std::optional<ImageSize> size;
  bool rotated = false;
  for (const auto& ipma : iprp_boxes) {
    if (ipma.type != "ipma" || ipma.body.size() < 8) {
      continue;
    }
    const std::string_view body = ipma.body;
    const uint32_t version = byte(body, 0);
    const bool wide_index = (byte(body, 3) & 1) != 0;
    const uint32_t count = be32(body, 4);
    size_t at = 8;
    for (uint32_t i = 0; i < count; ++i) {
      if (at + (version < 1 ? 3 : 5) > body.size()) {
        return std::nullopt;
      }
      const uint32_t item = version < 1 ? be16(body, at) : be32(body, at);
      at += version < 1 ? 2 : 4;
      const uint32_t associations = byte(body, at++);
      for (uint32_t j = 0; j < associations; ++j) {
        if (at + (wide_index ? 2 : 1) > body.size()) {
          return std::nullopt;
        }
        const uint32_t index = wide_index ? (be16(body, at) & 0x7FFF) : (byte(body, at) & 0x7F);
        at += wide_index ? 2 : 1;
        if (item != primary || index == 0 || index > properties.size()) {
          continue;
        }
        const Box& property = properties[index - 1];
        if (property.type == "ispe" && property.body.size() >= 12) {
          size = sized(be32(property.body, 4), be32(property.body, 8));
        } else if (property.type == "irot" && !property.body.empty()) {
          rotated = (byte(property.body, 0) & 1) != 0;
        } else if (property.type == "clap") {
          return std::nullopt;
        } else if (property.type == "pasp" && property.body.size() >= 8 &&
                   be32(property.body, 0) != be32(property.body, 4)) {
          return std::nullopt;
        }
      }
    }
  }
  if (size.has_value() && rotated) {
    return ImageSize{size->height, size->width};
  }
  return size;
}
}  // namespace

std::optional<ImageSize> image_size::read(std::string_view data) {
  if (data.starts_with("\x89PNG\r\n\x1A\n")) {
    return read_png(data);
  }
  if (data.starts_with("GIF87a") || data.starts_with("GIF89a")) {
    return read_gif(data);
  }
  if (data.starts_with("\xFF\xD8")) {
    return read_jpeg(data);
  }
  if (data.starts_with("RIFF")) {
    return read_webp(data);
  }
  if (data.starts_with("BM")) {
    return read_bmp(data);
  }
  if (data.size() >= 16 && data.substr(4, 4) == "ftyp") {
    // The major brand, then after the minor version the compatible brands.
    const size_t end = std::min<size_t>(be32(data, 0), data.size());
    for (size_t at = 8; at + 4 <= end; at += at == 8 ? 8 : 4) {
      const std::string_view brand = data.substr(at, 4);
      if (brand == "avif" || brand == "avis") {
        return read_avif(data);
      }
    }
  }
  return std::nullopt;
}
