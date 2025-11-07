cmake_minimum_required(VERSION 3.10)
project(VectorClusterStore)

# Set C++ standard
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Try to use pybind11 submodule first, then fall back to system installation
if(EXISTS "${CMAKE_SOURCE_DIR}/extern/pybind11/CMakeLists.txt")
    add_subdirectory(extern/pybind11)
    message(STATUS "Using pybind11 from submodule")
else()
    find_package(pybind11 REQUIRED)
    message(STATUS "Using system pybind11")
endif()

# Add include directories
include_directories(${CMAKE_SOURCE_DIR}/src)

# Define source files
set(VECTOR_STORE_SRCS 
    src/vector_cluster_store.cpp
    src/kmeans_clustering.cpp
)

# Main library
add_library(vector_cluster_store SHARED ${VECTOR_STORE_SRCS})
target_link_libraries(vector_cluster_store stdc++ m)

# Python bindings
pybind11_add_module(vector_cluster_store_py
    src/python_bindings.cpp
)
target_link_libraries(vector_cluster_store_py PRIVATE vector_cluster_store)

# Test executable
add_executable(test_cluster_store
    src/test_cluster_store.cpp
)
target_link_libraries(test_cluster_store vector_cluster_store stdc++ m)

# Raw device test executable
add_executable(raw_device_test
    src/raw_device_test.cpp
)
target_link_libraries(raw_device_test stdc++ m)

# Perf device test executable
add_executable(vector_store_test
    src/vector_store_test.cpp
)
target_link_libraries(vector_store_test vector_cluster_store stdc++ m)

# Vector store diagnostic tool
add_executable(vector_store_diagnostic
    src/vector_store_diagnostic.cpp
)
target_link_libraries(vector_store_diagnostic vector_cluster_store stdc++ m)

# Vector store validation tool
add_executable(vector_store_validate
    src/vector_store_validate.cpp
)
target_link_libraries(vector_store_validate vector_cluster_store stdc++ m)

# Vector store repair tool
add_executable(vector_store_repair
    src/vector_store_repair.cpp
)
target_link_libraries(vector_store_repair vector_cluster_store stdc++ m)

# Corruption detection test
add_executable(corruption_test
    src/corruption_test.cpp
)
target_link_libraries(corruption_test vector_cluster_store stdc++ m)

# Fast vector comparison tool
find_package(PkgConfig REQUIRED)
pkg_check_modules(CURL REQUIRED libcurl)
pkg_check_modules(JSONCPP REQUIRED jsoncpp)

add_executable(fastcomp
    src/fastcomp.cpp
)
target_include_directories(fastcomp PRIVATE ${CURL_INCLUDE_DIRS} ${JSONCPP_INCLUDE_DIRS})
target_link_libraries(fastcomp ${CURL_LIBRARIES} ${JSONCPP_LIBRARIES} stdc++ m)
target_compile_options(fastcomp PRIVATE ${CURL_CFLAGS_OTHER} ${JSONCPP_CFLAGS_OTHER})

# Installation
install(TARGETS vector_cluster_store vector_cluster_store_py
    LIBRARY DESTINATION lib
    RUNTIME DESTINATION bin
)

# Add a custom clean target for convenience
add_custom_target(clean_all
    COMMAND ${CMAKE_COMMAND} -P ${CMAKE_CURRENT_BINARY_DIR}/cmake_clean.cmake
)
