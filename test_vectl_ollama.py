#!/usr/bin/env python3
"""
Test script for vectl vector store with Ollama embeddings.
Tests basic embedding, storage, and search functionality.
"""
import sys
import os
import json
import requests
import time

# Add vectl build directory to path
vectl_build_path = os.path.join(os.path.dirname(__file__), "extern/vectl/build")
sys.path.insert(0, vectl_build_path)
import vector_cluster_store_py

# Configuration
OLLAMA_API_URL = "http://127.0.0.1:11434/api/embed"
EMBEDDING_MODEL = "nomic-embed-text"
VECTOR_DIM = 768
DEVICE_PATH = "./test_vector_store.bin"
LOG_FILE = "./test_vector_store.log"
METADATA_FILE = "./test_vector_store_metadata.json"

# Sample 6502-related texts for testing
TEST_TEXTS = [
    "The 6502 processor was developed by MOS Technology in 1975",
    "LDA instruction loads the accumulator with a value from memory",
    "The accumulator is an 8-bit register used for arithmetic operations",
    "JMP instruction changes the program counter to a new address",
    "The stack pointer points to the next free location on the stack",
    "ADC adds the value to the accumulator with carry",
    "The status register contains flags for processor state",
]


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
            print(f"Warning: Got {len(embedding)} dimensions, expected {VECTOR_DIM}")
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


def test_embedding_and_storage():
    """Test 1: Embed and store test texts."""
    print("\n" + "="*80)
    print("TEST 1: Embedding and Storage")
    print("="*80)

    store = init_vector_store()
    if not store:
        return False

    metadata = {"next_id": 0, "entries": {}}

    print(f"\nStoring {len(TEST_TEXTS)} test vectors...")
    for i, text in enumerate(TEST_TEXTS):
        print(f"\n[{i+1}/{len(TEST_TEXTS)}] Processing: \"{text[:60]}...\"")

        # Get embedding
        start = time.time()
        embedding = get_embedding(text)
        embed_time = time.time() - start

        if embedding is None:
            print(f"  ✗ Failed to get embedding")
            continue

        print(f"  ✓ Embedding generated in {embed_time:.3f}s")

        # Store vector
        vector_id = metadata["next_id"]
        entry = {
            "text": text,
            "model": EMBEDDING_MODEL,
            "timestamp": time.time()
        }
        metadata_json = json.dumps(entry)

        start = time.time()
        success = store.store_vector(vector_id, embedding, metadata_json)
        store_time = time.time() - start

        if success:
            print(f"  ✓ Stored as vector ID {vector_id} in {store_time*1000:.2f}ms")
            metadata["entries"][str(vector_id)] = entry
            metadata["next_id"] += 1
        else:
            print(f"  ✗ Failed to store vector")

    # Save metadata
    with open(METADATA_FILE, 'w') as f:
        json.dump(metadata, f, indent=2)

    print(f"\n✓ Stored {len(metadata['entries'])} vectors successfully")
    print(f"✓ Metadata saved to {METADATA_FILE}")

    return True


def test_vector_retrieval():
    """Test 2: Retrieve stored vectors."""
    print("\n" + "="*80)
    print("TEST 2: Vector Retrieval")
    print("="*80)

    store = init_vector_store()
    if not store:
        return False

    # Load metadata
    if not os.path.exists(METADATA_FILE):
        print("Error: Metadata file not found. Run test 1 first.")
        return False

    with open(METADATA_FILE, 'r') as f:
        metadata = json.load(f)

    print(f"\nRetrieving stored vectors...")
    for vector_id in range(min(3, len(metadata["entries"]))):  # Test first 3
        print(f"\n[Vector ID {vector_id}]")

        start = time.time()
        vector = store.retrieve_vector(vector_id)
        retrieve_time = time.time() - start

        if len(vector) > 0:
            entry = metadata["entries"].get(str(vector_id), {})
            text = entry.get("text", "Unknown")

            print(f"  ✓ Retrieved in {retrieve_time*1000:.2f}ms")
            print(f"  Dimensions: {len(vector)}")
            print(f"  Text: \"{text}\"")
        else:
            print(f"  ✗ Failed to retrieve vector")

    return True


def test_similarity_search():
    """Test 3: Search for similar vectors."""
    print("\n" + "="*80)
    print("TEST 3: Similarity Search")
    print("="*80)

    store = init_vector_store()
    if not store:
        return False

    # Load metadata
    if not os.path.exists(METADATA_FILE):
        print("Error: Metadata file not found. Run test 1 first.")
        return False

    with open(METADATA_FILE, 'r') as f:
        metadata = json.load(f)

    # Test queries
    test_queries = [
        "What is the accumulator register?",
        "How does the stack work?",
        "Tell me about jump instructions"
    ]

    for query in test_queries:
        print(f"\n{'─'*80}")
        print(f"Query: \"{query}\"")
        print(f"{'─'*80}")

        # Get query embedding
        start = time.time()
        embedding = get_embedding(query)
        embed_time = time.time() - start

        if embedding is None:
            print("✗ Failed to get query embedding")
            continue

        print(f"✓ Query embedded in {embed_time:.3f}s")

        # Search
        start = time.time()
        results = store.find_similar_vectors(embedding, 3)
        search_time = time.time() - start

        print(f"✓ Search completed in {search_time*1000:.2f}ms")

        if results:
            print(f"\nTop {len(results)} matches:")
            for rank, (vector_id, similarity) in enumerate(sorted(results, key=lambda x: x[1], reverse=True), 1):
                entry = metadata["entries"].get(str(vector_id), {})
                text = entry.get("text", "Unknown")
                print(f"  {rank}. [ID:{vector_id}] Score: {similarity:.4f}")
                print(f"     \"{text}\"")
        else:
            print("✗ No results found")

    return True


def cleanup():
    """Clean up test files."""
    print("\n" + "="*80)
    print("Cleanup")
    print("="*80)

    files_to_remove = [DEVICE_PATH, LOG_FILE, METADATA_FILE]
    for filepath in files_to_remove:
        if os.path.exists(filepath):
            os.remove(filepath)
            print(f"✓ Removed {filepath}")


def main():
    """Run all tests."""
    print("\n" + "="*80)
    print("VECTL + OLLAMA INTEGRATION TEST")
    print("="*80)
    print(f"Ollama API: {OLLAMA_API_URL}")
    print(f"Model: {EMBEDDING_MODEL}")
    print(f"Vector dimension: {VECTOR_DIM}")

    # Check Ollama connection
    print("\nChecking Ollama connection...")
    test_embedding = get_embedding("test")
    if test_embedding is None:
        print("✗ Failed to connect to Ollama. Is it running?")
        print(f"  Try: curl {OLLAMA_API_URL}")
        return 1
    print("✓ Ollama is running and responding")

    # Run tests
    try:
        if not test_embedding_and_storage():
            print("\n✗ Test 1 failed")
            return 1

        if not test_vector_retrieval():
            print("\n✗ Test 2 failed")
            return 1

        if not test_similarity_search():
            print("\n✗ Test 3 failed")
            return 1

        print("\n" + "="*80)
        print("✓ ALL TESTS PASSED")
        print("="*80)

        # Ask about cleanup
        response = input("\nCleanup test files? (y/n): ")
        if response.lower() == 'y':
            cleanup()

        return 0

    except KeyboardInterrupt:
        print("\n\nInterrupted by user")
        return 1
    except Exception as e:
        print(f"\n✗ Error: {e}")
        import traceback
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
