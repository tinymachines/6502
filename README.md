# 6502 Processor Expert Agent

An intelligent agent that answers questions about the 6502 processor using RAG (Retrieval-Augmented Generation) with vector similarity search.

## Overview

This project combines:
- **Mistral OCR**: Extracts text from 6502 processor documentation PDFs
- **vectl**: High-performance vector database for semantic search
- **Ollama**: Local LLM for embeddings and query processing
- **RAG Architecture**: Retrieves relevant documentation to answer questions accurately

## Quick Start

### Prerequisites

- Python 3.13+ (pyenv environment recommended)
- Ollama running locally
- CMake and C++17 compiler

### Installation

```bash
# 1. Install Python dependencies
pip install -r requirements.txt

# 2. Build and install vectl
cd extern/vectl
pip install pybind11 numpy
./build.sh rebuild
pip install -e .
python3 test_binding.py  # Verify installation
cd ../..

# 3. Verify Ollama is running
curl http://127.0.0.1:11434/api/embed \
  -d '{"model": "nomic-embed-text", "input": "test"}'
```

### Configuration

Create a `.env` file:
```bash
MISTRAL_API_KEY=your_key_here
MISTRAL_OCR_MODEL=mistral-ocr-latest
MISTRAL_VISION_MODEL=pixtral-large-latest2
```

## Project Structure

```
.
├── data/              # Processed OCR output (JSON)
├── docs/              # Source documentation PDFs
├── scripts/           # OCR processing utilities
├── src/agent/         # Agent implementation (WIP)
├── extern/vectl/      # Vector database
├── requirements.txt   # Python dependencies
└── CLAUDE.md          # Detailed development guide
```

## Documentation

For complete setup instructions, architecture details, and development workflow, see [CLAUDE.md](CLAUDE.md).

## Status

- ✅ Python project structure
- ✅ OCR processing pipeline
- ✅ Vector store (vectl) built and tested
- ⏳ Agent implementation (next step)

## Usage

### Process Documentation

```bash
# Upload PDF for OCR
./scripts/process.sh upload docs/6502_manual.pdf

# Download OCR results
./scripts/process.sh download <file_id> data/output.json
```

### Vector Search (Example)

```bash
cd extern/vectl
python3 examples/ollama_vector_search.py ./vector_store.bin
```

## License

[Your License Here]
