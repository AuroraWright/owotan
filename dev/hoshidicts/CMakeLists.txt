cmake_minimum_required(VERSION 3.22)
project(yomitan_hoshidicts LANGUAGES C CXX)

# Configured by dev/bin/build-hoshidicts.js, which checks out and patches the
# hoshidicts source.
set(HOSHIDICTS_SOURCE_DIR "" CACHE PATH "The patched hoshidicts checkout")
if(NOT EMSCRIPTEN)
  message(FATAL_ERROR "Configure with emcmake")
endif()

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(compile_flags -fwasm-exceptions -msimd128)
add_compile_options(${compile_flags})
# xxHash probes for headers wasm does not have. A function-style definition
# only passes through the flags.
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -D'XXH_HAS_INCLUDE(x)=0'")

add_subdirectory(${HOSHIDICTS_SOURCE_DIR} hoshidicts EXCLUDE_FROM_ALL)

add_executable(hoshidicts_wasm bindings.cpp)
target_link_libraries(hoshidicts_wasm PRIVATE hoshidicts glaze::glaze)
set_target_properties(hoshidicts_wasm PROPERTIES OUTPUT_NAME hoshidicts SUFFIX ".js")
set_property(TARGET hoshidicts_wasm APPEND PROPERTY LINK_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/library-opfs.jslib)
target_link_options(hoshidicts_wasm PRIVATE
  ${compile_flags}
  -sMODULARIZE=1
  -sEXPORT_ES6=1
  -sENVIRONMENT=web,worker,node
  -sALLOW_MEMORY_GROWTH=1
  -sMAXIMUM_MEMORY=4GB
  -sSTACK_SIZE=8MB
  -sFORCE_FILESYSTEM=1
  --js-library=${CMAKE_CURRENT_SOURCE_DIR}/library-opfs.jslib
  -sEXPORTED_FUNCTIONS=_yh_import,_yh_add,_yh_remove,_yh_find_terms,_yh_find_terms_by_sequence,_yh_glossaries,_yh_find_term_meta,_yh_find_kanji,_yh_find_kanji_meta,_yh_media,_yh_media_size
  -sEXPORTED_RUNTIME_METHODS=FS,OPFSFS,HEAPU8,cwrap)
