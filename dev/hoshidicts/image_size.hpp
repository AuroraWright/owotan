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

#pragma once

#include <cstdint>
#include <optional>
#include <string_view>

struct ImageSize {
  uint32_t width = 0;
  uint32_t height = 0;
};

namespace image_size {
// The size a browser shows an image at, read from its header without decoding
// it: PNG, GIF, JPEG, WebP, BMP and AVIF. Empty for any other format, a header
// that does not parse, and an image whose shown size the header alone does not
// settle: EXIF orientation in a PNG, or an AVIF crop, rotation or non-square
// pixels. A JPEG's EXIF orientation is applied. `data` may be the start of the
// file only: what it does not hold is not settled.
std::optional<ImageSize> read(std::string_view data);
}  // namespace image_size
