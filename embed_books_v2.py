#!/usr/bin/env python3
"""
Embed all 6502 book documentation into vector store.
Simplified version based on working test_book_embed.py
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

# Chunking settings
CHUNK_SIZE = 800
CHUNK_OVERLAP = 200

# Books to process
BOOK_FILES = [
    ("./data/book1.json", "6502 Programming Manual", "book1"),
    ("./data/book2-a.json", "6502 Assembly Language (Part 1)", "book2"),
    ("./data/book2-b.json", "6502 Assembly Language (Part 2)", "book2"),
    ("./data/book2-c.json", "6502 Assembly Language (Part 3)", "book2"),
]


def get_embedding(text):
    """Get embedding from Ollama."""
    payload = {"model": EMBEDDING_MODEL, "input": text}
    response = requests.post(OLLAMA_API_URL, json=payload, timeout=30)
    response.raise_for_status()
    embedding = response.json()["embeddings"][0]

    if len(embedding) != VECTOR_DIM:
        if len(embedding) > VECTOR_DIM:
            return embedding[:VECTOR_DIM]
        return embedding + [0.0] * (VECTOR_DIM - len(embedding))
    return embedding


def clean_text(text):
    """Clean markdown text."""
    text = re.sub(r'!\[.*?\]\(.*?\)', '', text)  # Remove images
    text = re.sub(r'\n\s*\n', '\n', text)  # Multiple newlines
    text = re.sub(r'\s+', ' ', text)  # Extra whitespace
    return text.strip()


def chunk_text(text, chunk_size=CHUNK_SIZE, overlap=CHUNK_OVERLAP):
    """Split text into overlapping chunks."""
    if len(text) <= chunk_size:
        return [text]

    chunks = []
    start = 0

    while start < len(text):
        end = start + chunk_size

        if end < len(text):
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


def main():
    print("\n" + "="*80)
    print("6502 BOOK EMBEDDING SYSTEM")
    print("="*80)

    # Check Ollama
    print("\nChecking Ollama...")
    try:
        test = get_embedding("test")
        print(f"✓ Ollama working ({len(test)} dimensions)")
    except Exception as e:
        print(f"✗ Ollama not responding: {e}")
        return 1

    # Initialize vector store ONCE
    print(f"\nInitializing vector store: {DEVICE_PATH}")
    logger = vector_cluster_store_py.Logger(LOG_FILE)
    store = vector_cluster_store_py.VectorClusterStore(logger)

    if not store.initialize(DEVICE_PATH, "kmeans", VECTOR_DIM, 10):
        print(f"✗ Failed to initialize. Check: {LOG_FILE}")
        return 1

    print("✓ Vector store ready")

    # Initialize metadata
    metadata = {
        "next_id": 0,
        "entries": {},
        "vector_dim": VECTOR_DIM,
        "created": datetime.now().isoformat(),
        "books": []
    }

    # Process each book
    total_chunks = 0
    total_time = 0
    overall_start = time.time()

    for book_path, book_name, book_id in BOOK_FILES:
        if not os.path.exists(book_path):
            print(f"\n⚠ Skipping {book_name} - file not found")
            continue

        print(f"\n{'='*80}")
        print(f"Processing: {book_name}")
        print(f"File: {book_path}")
        print(f"{'='*80}")

        # Load book
        with open(book_path, 'r') as f:
            book_data = json.load(f)

        pages = book_data.get('pages', [])
        print(f"Pages: {len(pages)}")

        book_chunks = 0
        book_start = time.time()
        last_save = time.time()

        for page_idx, page in enumerate(pages):
            page_num = page.get('index', page_idx)
            markdown = page.get('markdown', '')

            if not markdown or len(markdown.strip()) < 50:
                continue

            # Clean and chunk
            cleaned = clean_text(markdown)
            chunks = chunk_text(cleaned)

            for chunk_idx, chunk in enumerate(chunks):
                if len(chunk) < 50:
                    continue

                # Get embedding
                try:
                    embedding = get_embedding(chunk)
                except Exception as e:
                    print(f"\n✗ Embedding failed on page {page_num}: {e}")
                    continue

                # Store vector
                vector_id = metadata["next_id"]
                entry = {
                    "book_id": book_id,
                    "book_name": book_name,
                    "page": page_num,
                    "chunk": chunk_idx,
                    "text": chunk[:200] + "..." if len(chunk) > 200 else chunk,
                    "text_full": chunk,
                    "model": EMBEDDING_MODEL
                }

                # Store with simple metadata string
                meta_str = f"{book_id}:p{page_num}:c{chunk_idx}"

                try:
                    success = store.store_vector(vector_id, embedding, meta_str)
                except Exception as e:
                    print(f"\n✗ Store failed on page {page_num}: {e}")
                    continue

                if success:
                    metadata["entries"][str(vector_id)] = entry
                    metadata["next_id"] += 1
                    book_chunks += 1
                    total_chunks += 1

                # Save metadata every 50 chunks
                if time.time() - last_save >= 30:  # Every 30 seconds
                    with open(METADATA_FILE, 'w') as f:
                        json.dump(metadata, f, indent=2)
                    last_save = time.time()

                    elapsed = time.time() - book_start
                    avg_time = elapsed / book_chunks if book_chunks > 0 else 0
                    print(f"\r  Page {page_num+1}/{len(pages)} | {book_chunks} chunks | {avg_time:.2f}s/chunk avg", end='', flush=True)

        book_time = time.time() - book_start
        print(f"\n✓ Completed: {book_chunks} chunks in {book_time/60:.1f} minutes")

        if book_id not in metadata.get('books', []):
            if 'books' not in metadata:
                metadata['books'] = []
            metadata['books'].append(book_id)

        # Save after each book
        with open(METADATA_FILE, 'w') as f:
            json.dump(metadata, f, indent=2)
        print(f"✓ Metadata saved: {METADATA_FILE}")

    # Final summary
    total_time = time.time() - overall_start
    print(f"\n{'='*80}")
    print("EMBEDDING COMPLETE!")
    print(f"{'='*80}")
    print(f"Total chunks: {total_chunks}")
    print(f"Total time: {total_time/60:.1f} minutes")
    print(f"Average: {total_time/total_chunks:.2f}s per chunk")
    print(f"\nVector store: {DEVICE_PATH}")
    print(f"Metadata: {METADATA_FILE}")

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
