# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Development Commands

### Building the Project
- `./build.sh` - Clean and build the entire project (recommended)
- `./build.sh clean` - Clean build artifacts only
- `./build.sh rebuild` - Full clean and rebuild
- `make` - Build using Makefile (alternative to CMake)

### Testing
- `./build/test_cluster_store` - Run basic cluster storage tests
- `./build/vector_store_test` - Run performance and storage tests
- `./build/raw_device_test` - Test raw block device functionality
- `python test_binding.py` - Test Python bindings
- `python test_search.py` - Test search functionality

### Python Development
- `pip install -e .` - Install Python bindings in development mode
- `python ollama_vector_search.py ./vector_store.bin` - Run vector search example

## Architecture Overview

This is a high-performance vector database system with the following key components:

### Core C++ Library
- **VectorClusterStore** (`src/vector_cluster_store.{h,cpp}`) - Main storage engine with direct block device access
- **K-means Clustering** (`src/kmeans_clustering.{h,cpp}`) - Vector clustering for efficient similarity search
- **Logger** (`src/logger.h`) - Centralized logging system
- **Python Bindings** (`src/python_bindings.cpp`) - pybind11 interface for Python integration

### Storage Architecture
The system uses a structured layout on storage devices:
- **Header (512B)** - Store metadata and configuration
- **Cluster Map Region** - Cluster metadata and centroids
- **Vector Map Region** - Vector ID to storage location mapping
- **Vector Data Region** - Actual vector embeddings and metadata

### Key Features
- **Direct Block Device Access** - Bypasses filesystem for optimal performance on raw devices
- **Memory-mapped I/O** - High-throughput vector operations
- **Clustering-based Search** - K-means clustering for efficient similarity queries
- **Python Integration** - Full Python API for embedding into applications
- **File and Block Device Support** - Works with both files and raw block devices

### Data Flow
1. Vectors are clustered using K-means for spatial locality
2. Storage layout optimized for sequential and random access patterns
3. Vector similarity search uses cluster-aware algorithms
4. Python bindings provide high-level interface to C++ core

## Important Implementation Details

### Memory Management
- Uses aligned buffers for direct I/O operations
- Memory-mapped regions for efficient access patterns
- Thread-safe operations with mutex protection

### Error Handling
- Comprehensive logging through Logger class
- Graceful handling of device I/O failures
- Validation of vector store integrity on startup

### File Layout Compatibility
- Store signature verification (`VCSTOR1`)
- Version checking for backward compatibility
- Proper header validation before operations

### Development Notes
- Requires Linux system with C++17 support
- Block device operations require root privileges
- File-based storage recommended for development/testing
- Raw block device storage for production performance