# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a **6502 Processor Expert Agent** project that combines:
- **Documentation Processing**: Uses Mistral OCR API to extract text from 6502 processor documentation PDFs
- **Vector Storage**: Uses vectl (Vector Cluster Store) for efficient semantic search of processor documentation
- **LLM Integration**: Uses Ollama for local embeddings and query processing
- **Goal**: Create an intelligent agent that can answer questions about the 6502 processor using RAG (Retrieval-Augmented Generation)

## Project Structure

```
.
├── data/              # Processed OCR output (book1.json - 14MB+ JSON from Mistral OCR)
├── docs/              # Source documentation PDFs (empty - files processed via Mistral API)
├── scripts/           # Utility scripts for OCR processing
│   └── process.sh     # Mistral OCR API workflow script
├── extern/vectl/      # Vector Cluster Store (git submodule or external dependency)
└── .env               # Mistral API credentials (DO NOT COMMIT)
```

## Setup and Installation

### Prerequisites
- **Python 3.13+** (required for vectl Python bindings compatibility)
  - The project uses pyenv with Python 3.13.3 environment
  - vectl is compiled for Python 3.13 - use `/home/bisenbek/.pyenv/versions/3.13.3/envs/tinymachines/bin/python3`
- pip package manager
- Ollama installed and running locally (http://127.0.0.1:11434)
- CMake 3.10+ and C++17 compiler for building vectl
- pybind11 (installed via pip or as git submodule)

### Initial Setup

1. **Install main project dependencies**:
   ```bash
   pip install -r requirements.txt
   ```

2. **Build vectl (Vector Cluster Store)**:
   ```bash
   cd extern/vectl

   # Install pybind11 if not already installed
   pip install pybind11 numpy

   # Build the C++ library and Python bindings
   ./build.sh rebuild

   # Install Python package
   pip install -e .

   # Test installation
   python3 test_binding.py

   cd ../..
   ```

   **Important**: If vectl build fails with pybind11 errors, the CMakeLists.txt has been updated to use the pybind11 git submodule at `extern/pybind11/` instead of system installation.

3. **Verify Ollama is running**:
   ```bash
   curl http://127.0.0.1:11434/api/embed -d '{"model": "nomic-embed-text", "input": "test"}'
   ```

4. **Configure environment variables** (`.env` file):
   ```
   MISTRAL_API_KEY=<your-key>
   MISTRAL_OCR_MODEL=mistral-ocr-latest
   MISTRAL_VISION_MODEL=pixtral-large-latest2
   ```

   **⚠️ Security**: Never commit `.env` file to git (already in .gitignore)

## Common Development Tasks

### Processing Documentation with Mistral OCR

The `scripts/process.sh` script provides utilities for OCR processing:

```bash
# Upload a PDF for OCR processing
./scripts/process.sh upload docs/6502_manual.pdf

# Retrieve file URL (returns file_id from upload)
./scripts/process.sh retrieve <file_id>

# Download OCR results
./scripts/process.sh download <file_id> data/output.json

# Delete processed file from Mistral
./scripts/process.sh delete <file_id>

# Complete OCR workflow (retrieve + download)
./scripts/process.sh ocr <file_id>
```

### Working with Vector Store

The vectl library is located in `extern/vectl/`. Key scripts:

```bash
# Test Python bindings
cd extern/vectl
python test_binding.py

# Test vector search functionality
python test_search.py

# Run Ollama-based vector search (main application)
python examples/ollama_vector_search.py ./vector_store.bin
```

### Rebuilding vectl

If vectl needs repairs or updates:

```bash
cd extern/vectl
./build.sh clean
./build.sh rebuild
pip install -e .
```

## Architecture Details

### Data Flow

1. **Documentation Ingestion**:
   - PDF manuals → Mistral OCR API → JSON output (stored in `data/`)
   - OCR output includes text extraction, page images, and structural metadata

2. **Vector Embedding**:
   - JSON text chunks → Ollama (`nomic-embed-text` model) → 768-dim embeddings
   - Embeddings stored in vectl Vector Cluster Store

3. **Query Processing**:
   - User query → Ollama embedding → Vector similarity search → Retrieve relevant docs
   - Retrieved context + query → LLM → Answer about 6502 processor

### Vector Store Architecture

vectl uses a high-performance clustered vector storage system:
- **Storage Backend**: Direct block device access or file-based storage
- **Clustering**: K-means clustering for efficient similarity search
- **Python Bindings**: pybind11 interface to C++ core
- **Embedding Model**: nomic-embed-text (768 dimensions)
- **Default Storage**: `./vector_store.bin` (file-based for development)

### Key Components

- **Logger**: `vector_cluster_store_py.Logger()` - Centralized logging to file
- **VectorClusterStore**: Main storage engine with initialize/store/retrieve/search operations
- **Metadata Management**: JSON file tracking vector IDs and associated text chunks
- **Ollama Integration**: Local LLM for embeddings (avoids external API calls for queries)

## Important Implementation Notes

### OCR Data Format
- Mistral OCR returns large JSON files (14MB+ for typical manuals)
- Includes `include_image_base64: true` for page images
- Structure: Pages → Text blocks with coordinates and confidence scores

### Vector Dimensions
- **Critical**: All vectors must be 768 dimensions (nomic-embed-text standard)
- Dimension mismatches are handled by padding/truncating in `get_embedding()`
- Vector store initialized with `VECTOR_DIM = 768`

### Environment Configuration
- `.env` file contains Mistral API credentials - **NEVER commit to git**
- Ollama API expected at `http://127.0.0.1:11434/api/embed`
- Default embedding model: `nomic-embed-text`

### vectl Repair Notes
**✅ Fixed**: The vectl installation has been repaired and is now working.

Common issues that were resolved:
- **pybind11 headers not found** → Fixed by updating CMakeLists.txt to use git submodule at `extern/pybind11/`
- **Python version mismatch** → Built with Python 3.13 to match pyenv environment
- **Python bindings not building** → Resolved by using pybind11 submodule instead of system installation
- **Import errors** → Fixed by proper installation with `pip install -e .`

Current status:
- C++ library: ✅ Built (`libvector_cluster_store.so`)
- Python bindings: ✅ Built (`vector_cluster_store_py.cpython-313-x86_64-linux-gnu.so`)
- Test suite: ✅ Passing (`test_binding.py` succeeds)

## Testing and Validation

### Verify Vector Store
```bash
cd extern/vectl
python test_binding.py  # Test Python bindings work
```

### Test Ollama Connection
```bash
curl http://127.0.0.1:11434/api/embed \
  -d '{"model": "nomic-embed-text", "input": "6502 processor"}'
```

### Validate OCR Output
```python
import json
with open('data/book1.json') as f:
    data = json.load(f)
    print(f"Pages: {len(data['pages'])}")
```

## Development Workflow

1. **Add new documentation**: Upload PDFs via `scripts/process.sh`
2. **Process OCR results**: Extract text chunks from JSON output
3. **Generate embeddings**: Use Ollama to create vector embeddings
4. **Store vectors**: Add to vectl vector store with metadata
5. **Query system**: Search for relevant chunks using similarity search
6. **Generate answers**: Use retrieved context with LLM to answer 6502 questions

## Project Status

- Python project structure: ✅ Complete (setup.py, pyproject.toml, requirements.txt)
- OCR processing pipeline: ✅ Working (sample: data/book1.json)
- Vector store (vectl): ✅ Built and tested successfully
- Ollama integration: ⏳ Ready to implement (vectl working, example code available)
- Agent implementation: ⏳ Next step
