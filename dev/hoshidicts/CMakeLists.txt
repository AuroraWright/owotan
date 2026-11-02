cmake_minimum_required(VERSION 3.22)
project(yomitan_hoshidicts LANGUAGES C CXX)

# Configured by dev/bin/build-hoshidicts.js, which checks out and patches the
# hoshidicts source.
set(HOSHIDICTS_SOURCE_DIR "" CACHE PATH "The patched hoshidicts checkout")
# The threaded build imports dictionaries on up to 8 threads. It needs a
# cross-origin isolated page and is used only to import.
option(YOMITAN_HOSHIDICTS_THREADS "Build hoshidicts-threads, with threads" OFF)
if(NOT EMSCRIPTEN)
  message(FATAL_ERROR "Configure with emcmake")
endif()

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(compile_flags -fwasm-exceptions -msimd128)
set(output_name hoshidicts)
set(thread_link_options)
if(YOMITAN_HOSHIDICTS_THREADS)
  list(APPEND compile_flags -pthread)
  set(output_name hoshidicts-threads)
  # The default allocator takes one lock for every allocation; with it, the
  # import threads of a dictionary of many short entries were slower than one.
  # The pool covers hoshidicts' import threads (at most 8), which start while
  # the calling thread is blocked and so cannot wait for a worker to load.
  set(thread_link_options
    -sMALLOC=mimalloc
    "-sPTHREAD_POOL_SIZE=Math.min(navigator.hardwareConcurrency || 1, 8)")
endif()
add_compile_options(${compile_flags})
# xxHash probes for headers wasm does not have. A function-style definition
# only passes through the flags.
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -D'XXH_HAS_INCLUDE(x)=0'")

add_subdirectory(${HOSHIDICTS_SOURCE_DIR} hoshidicts EXCLUDE_FROM_ALL)

add_executable(hoshidicts_wasm bindings.cpp)
target_link_libraries(hoshidicts_wasm PRIVATE hoshidicts glaze::glaze)
set_target_properties(hoshidicts_wasm PROPERTIES OUTPUT_NAME ${output_name} SUFFIX ".js")
set_property(TARGET hoshidicts_wasm APPEND PROPERTY LINK_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/library-opfs.jslib)
target_link_options(hoshidicts_wasm PRIVATE
  ${compile_flags}
  ${thread_link_options}
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
