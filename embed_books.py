#!/usr/bin/env python3
"""
Embed 6502 book documentation into vector store.
Processes JSON OCR output and creates searchable vector embeddings.
"""
import sys
import os
import json
import requests
import time
import re
from datetime import datetime

# Add vectl to path
vectl_build_path = os.path.join(os.path.dirname(__file__), "extern/vectl/build")
sys.path.insert(0, vectl_build_path)
import vector_cluster_store_py

# Configuration
OLLAMA_API_URL = "http://127.0.0.1:11434/api/embed"
EMBEDDING_MODEL = "nomic-embed-text"
VECTOR_DIM = 768
DEVICE_PATH = "./6502_vector_store.bin"
LOG_FILE = "./6502_vector_store.log"
METADATA_FILE = "./6502_vector_store_metadata.json"

# Text chunking settings
CHUNK_SIZE = 800  # Characters per chunk
CHUNK_OVERLAP = 200  # Overlap between chunks for context

# Book files to process
BOOK_FILES = [
    {
        "path": "./data/book1.json",
        "name": "6502 Programming Manual",
        "book_id": "book1"
    },
    {
        "path": "./data/book2-a.json",
        "name": "6502 Assembly Language Programming (Part 1)",
        "book_id": "book2"
    },
    {
        "path": "./data/book2-b.json",
        "name": "6502 Assembly Language Programming (Part 2)",
        "book_id": "book2"
    },
    {
        "path": "./data/book2-c.json",
        "name": "6502 Assembly Language Programming (Part 3)",
        "book_id": "book2"
    }
]

# Limit pages for testing (set to None to process all)
MAX_PAGES_PER_BOOK = None  # Change to a number like 50 for testing


def get_embedding(text):
    """Get embedding vector from Ollama."""
    try:
        payload = {"model": EMBEDDING_MODEL, "input": text}
        response = requests.post(OLLAMA_API_URL, json=payload, timeout=30)
        response.raise_for_status()
        data = response.json()

        embedding = data["embeddings"][0]

        # Verify dimension
        if len(embedding) != VECTOR_DIM:
            if len(embedding) > VECTOR_DIM:
                return embedding[:VECTOR_DIM]
            else:
                return embedding + [0.0] * (VECTOR_DIM - len(embedding))

        return embedding
    except Exception as e:
        print(f"Error getting embedding: {e}")
        return None


def init_vector_store():
    """Initialize the vector store."""
    try:
        logger = vector_cluster_store_py.Logger(LOG_FILE)
        store = vector_cluster_store_py.VectorClusterStore(logger)

        if not store.initialize(DEVICE_PATH, "kmeans", VECTOR_DIM, 10):
            print(f"Error initializing vector store. Check log: {LOG_FILE}")
            return None

        print(f"✓ Vector store initialized: {DEVICE_PATH}")
        return store
    except Exception as e:
        print(f"Error initializing vector store: {e}")
        import traceback
        traceback.print_exc()
        return None


def load_metadata():
    """Load existing metadata or create new."""
    if os.path.exists(METADATA_FILE):
        try:
            with open(METADATA_FILE, 'r') as f:
                return json.load(f)
        except Exception as e:
            print(f"Error loading metadata: {e}")

    return {
        "next_id": 0,
        "entries": {},
        "vector_dim": VECTOR_DIM,
        "created": datetime.now().isoformat(),
        "books": []
    }


def save_metadata(metadata):
    """Save metadata to file."""
    try:
        metadata["last_updated"] = datetime.now().isoformat()
        with open(METADATA_FILE, 'w') as f:
            json.dump(metadata, f, indent=2)
    except Exception as e:
        print(f"Error saving metadata: {e}")


def clean_text(text):
    """Clean markdown text for embedding."""
    # Remove image references
    text = re.sub(r'!\[.*?\]\(.*?\)', '', text)
    # Remove multiple newlines
    text = re.sub(r'\n\s*\n', '\n', text)
    # Remove excessive whitespace
    text = re.sub(r'\s+', ' ', text)
    return text.strip()


def chunk_text(text, chunk_size=CHUNK_SIZE, overlap=CHUNK_OVERLAP):
    """Split text into overlapping chunks."""
    if len(text) <= chunk_size:
        return [text]

    chunks = []
    start = 0

    while start < len(text):
        end = start + chunk_size

        # Try to break at sentence boundary
        if end < len(text):
            # Look for period, question mark, or exclamation within last 100 chars
            search_start = max(end - 100, start)
            sentence_end = max(
                text.rfind('. ', search_start, end),
                text.rfind('? ', search_start, end),
                text.rfind('! ', search_start, end)
            )
            if sentence_end > start:
                end = sentence_end + 1

        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)

        start = end - overlap

    return chunks


def embed_book(store, book_info, metadata):
    """Embed a single book file."""
    print(f"\n{'='*80}")
    print(f"Processing: {book_info['name']}")
    print(f"File: {book_info['path']}")
    print(f"{'='*80}")

    # Note: store parameter is passed in, not created here

    # Load book JSON
    try:
        with open(book_info['path'], 'r') as f:
            book_data = json.load(f)
    except Exception as e:
        print(f"✗ Error loading book: {e}")
        return 0

    pages = book_data.get('pages', [])

    # Limit pages if MAX_PAGES_PER_BOOK is set
    if MAX_PAGES_PER_BOOK is not None:
        pages = pages[:MAX_PAGES_PER_BOOK]
        print(f"Pages: {len(pages)} (limited from {len(book_data.get('pages', []))})")
    else:
        print(f"Pages: {len(pages)}")

    total_chunks = 0
    total_time = 0
    start_id = metadata["next_id"]
    last_progress_time = time.time()

    for page_idx, page in enumerate(pages):
        page_num = page.get('index', page_idx)
        markdown = page.get('markdown', '')

        if not markdown or len(markdown.strip()) < 50:
            continue

        # Clean and chunk the text
        cleaned_text = clean_text(markdown)
        chunks = chunk_text(cleaned_text)

        # Show progress every 2 seconds
        now = time.time()
        if now - last_progress_time >= 2:
            print(f"\rPage {page_num + 1}/{len(pages)} ({total_chunks} chunks embedded, {total_time/max(total_chunks,1):.2f}s/chunk avg)", end='', flush=True)
            last_progress_time = now

        for chunk_idx, chunk in enumerate(chunks):
            if len(chunk) < 50:  # Skip very small chunks
                continue

            # Get embedding
            start_time = time.time()
            embedding = get_embedding(chunk)
            embed_time = time.time() - start_time
            total_time += embed_time

            if embedding is None:
                print(f"\n✗ Failed to embed chunk {chunk_idx} on page {page_num}")
                continue

            # Store vector
            vector_id = metadata["next_id"]
            entry = {
                "book_id": book_info["book_id"],
                "book_name": book_info["name"],
                "page": page_num,
                "chunk": chunk_idx,
                "text": chunk[:200] + "..." if len(chunk) > 200 else chunk,  # Store preview
                "text_full": chunk,  # Store full text
                "model": EMBEDDING_MODEL,
                "timestamp": time.time()
            }
            metadata_json = json.dumps(entry)

            success = store.store_vector(vector_id, embedding, metadata_json)

            if success:
                metadata["entries"][str(vector_id)] = entry
                metadata["next_id"] += 1
                total_chunks += 1
            else:
                print(f"\n✗ Failed to store chunk {chunk_idx} on page {page_num}")

            # Save metadata periodically (every 50 chunks)
            if total_chunks % 50 == 0:
                save_metadata(metadata)

    print()  # New line after progress
    print(f"✓ Processed {total_chunks} chunks")
    print(f"✓ Average embedding time: {total_time/total_chunks:.3f}s per chunk")
    print(f"✓ Vector IDs: {start_id} to {metadata['next_id'] - 1}")

    # Final save
    save_metadata(metadata)

    return total_chunks


def main():
    """Main entry point."""
    print("\n" + "="*80)
    print("6502 BOOK EMBEDDING SYSTEM")
    print("="*80)
    print(f"Ollama API: {OLLAMA_API_URL}")
    print(f"Model: {EMBEDDING_MODEL}")
    print(f"Vector dimension: {VECTOR_DIM}")
    print(f"Chunk size: {CHUNK_SIZE} chars (overlap: {CHUNK_OVERLAP})")

    # Check Ollama connection
    print("\nChecking Ollama connection...")
    test_embedding = get_embedding("test")
    if test_embedding is None:
        print("✗ Failed to connect to Ollama. Is it running?")
        return 1
    print("✓ Ollama is running and responding")

    # Initialize vector store
    store = init_vector_store()
    if not store:
        return 1

    # Load metadata
    metadata = load_metadata()
    print(f"\nStarting vector ID: {metadata['next_id']}")

    # Process each book
    total_start = time.time()
    grand_total = 0

    for book_info in BOOK_FILES:
        if not os.path.exists(book_info['path']):
            print(f"\n⚠ Skipping {book_info['name']} - file not found")
            continue

        chunks = embed_book(store, book_info, metadata)
        grand_total += chunks

        if book_info['book_id'] not in metadata.get('books', []):
            if 'books' not in metadata:
                metadata['books'] = []
            metadata['books'].append(book_info['book_id'])

    total_time = time.time() - total_start

    # Final summary
    print(f"\n{'='*80}")
    print("EMBEDDING COMPLETE")
    print(f"{'='*80}")
    print(f"Total chunks embedded: {grand_total}")
    print(f"Total time: {total_time/60:.2f} minutes")
    print(f"Average: {total_time/grand_total:.3f}s per chunk")
    print(f"Vector store: {DEVICE_PATH}")
    print(f"Metadata: {METADATA_FILE}")

    # Save final metadata
    save_metadata(metadata)

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n\n⚠ Interrupted by user")
        sys.exit(1)
    except Exception as e:
        print(f"\n✗ Error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
