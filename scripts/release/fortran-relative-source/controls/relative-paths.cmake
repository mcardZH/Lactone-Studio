# Build-time path handling only; preserve the compiler and numerical options.
if(NOT DEFINED ES_BUILD_PYTHON OR NOT EXISTS "${ES_BUILD_PYTHON}")
  message(FATAL_ERROR "Set ES_BUILD_PYTHON to an existing Python 3.9+ interpreter")
endif()
get_filename_component(_es_build_root "${CMAKE_CURRENT_LIST_DIR}/.." ABSOLUTE)
set(_es_launcher "${CMAKE_CURRENT_LIST_DIR}/relative-source-launcher.py")
set(CMAKE_Fortran_COMPILER_LAUNCHER "${ES_BUILD_PYTHON};${_es_launcher};${_es_build_root}/source")
set(_es_preprocess_launcher "\"${ES_BUILD_PYTHON}\" \"${_es_launcher}\" \"${_es_build_root}/source\" ")
string(REPLACE "<CMAKE_Fortran_COMPILER>" "${_es_preprocess_launcher}<CMAKE_Fortran_COMPILER>" CMAKE_Fortran_PREPROCESS_SOURCE "${CMAKE_Fortran_PREPROCESS_SOURCE}")
