#!/usr/bin/env python3
"""
Minimal test to isolate embedding issue with book data.
"""
import sys
import os
import json
import requests

# Add vectl to path
vectl_build_path = os.path.join(os.path.dirname(__file__), "extern/vectl/build")
sys.path.insert(0, vectl_build_path)
import vector_cluster_store_py

# Config
OLLAMA_API_URL = "http://127.0.0.1:11434/api/embed"
EMBEDDING_MODEL = "nomic-embed-text"
VECTOR_DIM = 768
DEVICE_PATH = "./test_book_vector_store.bin"
LOG_FILE = "./test_book_vector_store.log"

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

def main():
    print("Loading book data...")
    with open('./data/book1.json', 'r') as f:
        book_data = json.load(f)

    # Get first page with content
    first_page = book_data['pages'][5]  # Page 5 had content based on earlier logs
    markdown = first_page.get('markdown', '')

    print(f"First page text length: {len(markdown)}")
    print(f"First 200 chars: {markdown[:200]}")

    # Get embedding
    print("\nGetting embedding...")
    embedding = get_embedding(markdown[:500])  # Just first 500 chars
    print(f"✓ Embedding received: {len(embedding)} dimensions")

    # Initialize vector store
    print("\nInitializing vector store...")
    logger = vector_cluster_store_py.Logger(LOG_FILE)
    store = vector_cluster_store_py.VectorClusterStore(logger)

    if not store.initialize(DEVICE_PATH, "kmeans", VECTOR_DIM, 10):
        print("✗ Failed to initialize")
        return 1

    print("✓ Vector store initialized")

    # Store the vector
    print("\nStoring vector...")
    metadata_json = json.dumps({"text": markdown[:200], "page": 5})

    success = store.store_vector(0, embedding, metadata_json)

    if success:
        print("✓ Vector stored successfully!")

        # Try to retrieve it
        print("\nRetrieving vector...")
        retrieved = store.retrieve_vector(0)
        print(f"✓ Retrieved: {len(retrieved)} dimensions")

        return 0
    else:
        print("✗ Failed to store vector")
        return 1

if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
