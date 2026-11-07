cmake_minimum_required(VERSION 3.22)
project(yomitan_mecab LANGUAGES CXX)

# Configured by dev/bin/build-mecab.js, which checks out the MeCab source.
# Builds MeCab's library, which ext/js/comm/mecab-worker-main.js runs.
set(MECAB_SOURCE_DIR "" CACHE PATH "The MeCab checkout")
if(NOT EMSCRIPTEN)
  message(FATAL_ERROR "Configure with emcmake")
endif()

set(CMAKE_CXX_STANDARD 11)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(compile_flags -fwasm-exceptions)

# The library's sources, as listed for libmecab in mecab/src/Makefile.am
set(source_dir ${MECAB_SOURCE_DIR}/mecab/src)
set(sources
  viterbi.cpp tagger.cpp utils.cpp eval.cpp iconv_utils.cpp dictionary_rewriter.cpp
  dictionary_generator.cpp dictionary_compiler.cpp context_id.cpp connector.cpp
  nbest_generator.cpp writer.cpp string_buffer.cpp param.cpp tokenizer.cpp
  char_property.cpp dictionary.cpp feature_index.cpp lbfgs.cpp learner_tagger.cpp
  learner.cpp libmecab.cpp)
list(TRANSFORM sources PREPEND ${source_dir}/)

add_executable(mecab_wasm ${sources})
# What MeCab's configure script would find. Dictionaries are read with read(),
# since memory mapping in wasm only copies the file.
target_compile_definitions(mecab_wasm PRIVATE
  DIC_VERSION=102
  PACKAGE="mecab"
  VERSION="0.996"
  MECAB_DEFAULT_RC="/mecabrc"
  HAVE_UNISTD_H HAVE_STDINT_H HAVE_SYS_TYPES_H HAVE_SYS_STAT_H HAVE_FCNTL_H
  HAVE_STRING_H HAVE_DIRENT_H HAVE_GETENV)
target_compile_options(mecab_wasm PRIVATE ${compile_flags} -O2 -Wno-register -Wno-deprecated-declarations)
set_target_properties(mecab_wasm PROPERTIES OUTPUT_NAME mecab SUFFIX ".js")
set_property(TARGET mecab_wasm APPEND PROPERTY LINK_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/../hoshidicts/library-opfs.jslib)
target_link_options(mecab_wasm PRIVATE
  ${compile_flags}
  -O2
  -sMODULARIZE=1
  -sEXPORT_ES6=1
  -sENVIRONMENT=web,worker,node
  -sALLOW_MEMORY_GROWTH=1
  -sMAXIMUM_MEMORY=4GB
  -sFORCE_FILESYSTEM=1
  --js-library=${CMAKE_CURRENT_SOURCE_DIR}/../hoshidicts/library-opfs.jslib
  -sEXPORTED_FUNCTIONS=_mecab_new2,_mecab_sparse_tostr,_mecab_strerror,_mecab_destroy
  -sEXPORTED_RUNTIME_METHODS=FS,OPFSFS,cwrap)
