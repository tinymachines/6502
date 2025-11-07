#!/usr/bin/env python3
"""
Comprehensive search tests for 6502 vector store.
Tests similarity search, embedding comparison, and result relevance.
"""
import sys
import os
import json
import requests
import numpy as np
from typing import List, Tuple

# Add vectl to path
vectl_build_path = os.path.join(os.path.dirname(__file__), "extern/vectl/build")
sys.path.insert(0, vectl_build_path)
import vector_cluster_store_py

# Configuration
OLLAMA_API_URL = "http://127.0.0.1:11434/api/embed"
EMBEDDING_MODEL = "nomic-embed-text"
VECTOR_DIM = 768
DEVICE_PATH = "./6502_vector_store.bin"
LOG_FILE = "./6502_search_test.log"
METADATA_FILE = "./6502_vector_store_metadata.json"

# Test queries covering different aspects of 6502
TEST_QUERIES = [
    # Instructions
    {
        "query": "How does the LDA instruction work?",
        "expected_keywords": ["LDA", "load", "accumulator", "memory"],
        "min_score": 0.6
    },
    {
        "query": "What is the ADC instruction?",
        "expected_keywords": ["ADC", "add", "carry", "accumulator"],
        "min_score": 0.6
    },
    {
        "query": "Jump instructions in 6502",
        "expected_keywords": ["JMP", "JSR", "jump", "branch"],
        "min_score": 0.5
    },
    # Registers
    {
        "query": "Tell me about the accumulator register",
        "expected_keywords": ["accumulator", "register", "8-bit", "arithmetic"],
        "min_score": 0.7
    },
    {
        "query": "What is the stack pointer?",
        "expected_keywords": ["stack", "pointer", "register", "page"],
        "min_score": 0.6
    },
    # Addressing modes
    {
        "query": "Explain indexed addressing mode",
        "expected_keywords": ["index", "address", "X", "Y"],
        "min_score": 0.5
    },
    {
        "query": "What is zero page addressing?",
        "expected_keywords": ["zero", "page", "address", "fast"],
        "min_score": 0.5
    },
    # Architecture
    {
        "query": "6502 memory map",
        "expected_keywords": ["memory", "address", "page", "RAM"],
        "min_score": 0.5
    },
    {
        "query": "Status flags in 6502",
        "expected_keywords": ["flag", "status", "register", "carry", "zero"],
        "min_score": 0.5
    },
]


def get_embedding(text: str) -> List[float]:
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


def cosine_similarity(vec1: List[float], vec2: List[float]) -> float:
    """Calculate cosine similarity between two vectors."""
    vec1_np = np.array(vec1)
    vec2_np = np.array(vec2)

    dot_product = np.dot(vec1_np, vec2_np)
    norm1 = np.linalg.norm(vec1_np)
    norm2 = np.linalg.norm(vec2_np)

    if norm1 == 0 or norm2 == 0:
        return 0.0

    return float(dot_product / (norm1 * norm2))


def euclidean_distance(vec1: List[float], vec2: List[float]) -> float:
    """Calculate Euclidean distance between two vectors."""
    vec1_np = np.array(vec1)
    vec2_np = np.array(vec2)
    return float(np.linalg.norm(vec1_np - vec2_np))


def test_basic_search():
    """Test 1: Basic search functionality."""
    print("\n" + "="*80)
    print("TEST 1: Basic Vector Search")
    print("="*80)

    # Load vector store
    logger = vector_cluster_store_py.Logger(LOG_FILE)
    store = vector_cluster_store_py.VectorClusterStore(logger)

    if not store.initialize(DEVICE_PATH, "kmeans", VECTOR_DIM, 10):
        print("✗ Failed to initialize vector store")
        return False

    # Load metadata
    with open(METADATA_FILE, 'r') as f:
        metadata = json.load(f)

    print(f"✓ Vector store loaded: {metadata['next_id']} vectors")

    # Test simple query
    query = "What is the LDA instruction?"
    print(f"\nQuery: \"{query}\"")

    embedding = get_embedding(query)
    results = store.find_similar_vectors(embedding, 5)

    if not results:
        print("✗ No results returned")
        return False

    print(f"✓ Found {len(results)} results")

    for i, (vector_id, score) in enumerate(sorted(results, key=lambda x: x[1], reverse=True), 1):
        entry = metadata["entries"].get(str(vector_id), {})
        text = entry.get("text", "Unknown")
        book = entry.get("book_name", "Unknown")
        page = entry.get("page", "?")

        print(f"  {i}. [ID:{vector_id}] Score: {score:.4f} | {book} p.{page}")
        print(f"     {text[:100]}...")

    return True


def test_embedding_similarity():
    """Test 2: Manual embedding similarity comparison."""
    print("\n" + "="*80)
    print("TEST 2: Embedding Similarity Comparison")
    print("="*80)

    # Test similar queries
    query1 = "LDA instruction loads accumulator"
    query2 = "Load value into accumulator register"
    query3 = "Jump to subroutine"  # Different topic

    print(f"Query 1: \"{query1}\"")
    print(f"Query 2: \"{query2}\" (similar)")
    print(f"Query 3: \"{query3}\" (different)")

    emb1 = get_embedding(query1)
    emb2 = get_embedding(query2)
    emb3 = get_embedding(query3)

    # Calculate similarities
    sim_1_2 = cosine_similarity(emb1, emb2)
    sim_1_3 = cosine_similarity(emb1, emb3)
    dist_1_2 = euclidean_distance(emb1, emb2)
    dist_1_3 = euclidean_distance(emb1, emb3)

    print(f"\nCosine Similarity:")
    print(f"  Query 1 vs 2 (similar): {sim_1_2:.4f}")
    print(f"  Query 1 vs 3 (different): {sim_1_3:.4f}")

    print(f"\nEuclidean Distance:")
    print(f"  Query 1 vs 2 (similar): {dist_1_2:.4f}")
    print(f"  Query 1 vs 3 (different): {dist_1_3:.4f}")

    # Validate expectations
    if sim_1_2 > sim_1_3:
        print("\n✓ Similar queries have higher cosine similarity")
    else:
        print("\n✗ Similar queries don't have higher similarity")
        return False

    if dist_1_2 < dist_1_3:
        print("✓ Similar queries have lower Euclidean distance")
    else:
        print("✗ Similar queries don't have lower distance")
        return False

    return True


def test_result_relevance():
    """Test 3: Validate search result relevance."""
    print("\n" + "="*80)
    print("TEST 3: Search Result Relevance")
    print("="*80)

    # Initialize
    logger = vector_cluster_store_py.Logger(LOG_FILE)
    store = vector_cluster_store_py.VectorClusterStore(logger)
    store.initialize(DEVICE_PATH, "kmeans", VECTOR_DIM, 10)

    with open(METADATA_FILE, 'r') as f:
        metadata = json.load(f)

    passed = 0
    failed = 0

    for test_case in TEST_QUERIES:
        query = test_case["query"]
        expected_keywords = test_case["expected_keywords"]
        min_score = test_case["min_score"]

        print(f"\n{'─'*80}")
        print(f"Query: \"{query}\"")
        print(f"Expected keywords: {', '.join(expected_keywords)}")

        embedding = get_embedding(query)
        results = store.find_similar_vectors(embedding, 3)

        if not results:
            print("✗ No results found")
            failed += 1
            continue

        # Check top result
        top_id, top_score = max(results, key=lambda x: x[1])
        entry = metadata["entries"].get(str(top_id), {})
        text_full = entry.get("text_full", entry.get("text", ""))

        print(f"Top result: Score {top_score:.4f}")
        print(f"  {entry.get('book_name', 'Unknown')} p.{entry.get('page', '?')}")
        print(f"  {text_full[:150]}...")

        # Check for keywords
        text_lower = text_full.lower()
        found_keywords = [kw for kw in expected_keywords if kw.lower() in text_lower]

        print(f"Found keywords: {', '.join(found_keywords) if found_keywords else 'None'}")

        # Validate
        if top_score >= min_score and found_keywords:
            print(f"✓ PASS - Good score and relevant keywords")
            passed += 1
        elif top_score >= min_score:
            print(f"⚠ PARTIAL - Good score but missing keywords")
            passed += 0.5
        elif found_keywords:
            print(f"⚠ PARTIAL - Has keywords but low score")
            passed += 0.5
        else:
            print(f"✗ FAIL - Low score and no keywords")
            failed += 1

    print(f"\n{'='*80}")
    print(f"Results: {passed}/{len(TEST_QUERIES)} passed, {failed} failed")

    return passed >= len(TEST_QUERIES) * 0.7  # 70% pass rate


def test_cross_reference_search():
    """Test 4: Cross-reference between related concepts."""
    print("\n" + "="*80)
    print("TEST 4: Cross-Reference Search")
    print("="*80)

    logger = vector_cluster_store_py.Logger(LOG_FILE)
    store = vector_cluster_store_py.VectorClusterStore(logger)
    store.initialize(DEVICE_PATH, "kmeans", VECTOR_DIM, 10)

    with open(METADATA_FILE, 'r') as f:
        metadata = json.load(f)

    # Find LDA instruction
    print("Step 1: Finding LDA instruction...")
    lda_query = get_embedding("LDA instruction")
    lda_results = store.find_similar_vectors(lda_query, 1)
    lda_id, lda_score = lda_results[0]

    print(f"✓ Found LDA: ID {lda_id}, Score {lda_score:.4f}")

    # Use LDA's embedding to find related instructions
    print("\nStep 2: Finding related instructions using LDA's embedding...")
    lda_vector = store.retrieve_vector(lda_id)
    related_results = store.find_similar_vectors(lda_vector, 5)

    print(f"✓ Found {len(related_results)} related vectors:")
    for i, (vec_id, score) in enumerate(sorted(related_results, key=lambda x: x[1], reverse=True)[:5], 1):
        if vec_id == lda_id:
            continue
        entry = metadata["entries"].get(str(vec_id), {})
        text = entry.get("text", "Unknown")
        print(f"  {i}. Score: {score:.4f} | {text[:80]}...")

    return len(related_results) > 1


def test_book_coverage():
    """Test 5: Verify coverage across all books."""
    print("\n" + "="*80)
    print("TEST 5: Book Coverage")
    print("="*80)

    logger = vector_cluster_store_py.Logger(LOG_FILE)
    store = vector_cluster_store_py.VectorClusterStore(logger)
    store.initialize(DEVICE_PATH, "kmeans", VECTOR_DIM, 10)

    with open(METADATA_FILE, 'r') as f:
        metadata = json.load(f)

    # Count vectors per book
    book_counts = {}
    for entry in metadata["entries"].values():
        book_id = entry.get("book_id", "unknown")
        book_counts[book_id] = book_counts.get(book_id, 0) + 1

    print("Vectors per book:")
    for book_id, count in sorted(book_counts.items()):
        pct = (count / metadata["next_id"]) * 100
        print(f"  {book_id}: {count} vectors ({pct:.1f}%)")

    # Test query that should hit both books
    query = "6502 programming techniques"
    print(f"\nTesting cross-book query: \"{query}\"")

    embedding = get_embedding(query)
    results = store.find_similar_vectors(embedding, 10)

    books_in_results = set()
    for vec_id, score in results:
        entry = metadata["entries"].get(str(vec_id), {})
        books_in_results.add(entry.get("book_id", "unknown"))

    print(f"✓ Results span {len(books_in_results)} books: {', '.join(books_in_results)}")

    return len(books_in_results) >= 2


def main():
    """Run all tests."""
    print("\n" + "="*80)
    print("6502 VECTOR STORE SEARCH TESTS")
    print("="*80)

    # Check prerequisites
    if not os.path.exists(DEVICE_PATH):
        print(f"✗ Vector store not found: {DEVICE_PATH}")
        print("Please run embed_books_v2.py first")
        return 1

    if not os.path.exists(METADATA_FILE):
        print(f"✗ Metadata not found: {METADATA_FILE}")
        return 1

    # Run tests
    results = {}

    try:
        results["basic_search"] = test_basic_search()
        results["embedding_similarity"] = test_embedding_similarity()
        results["result_relevance"] = test_result_relevance()
        results["cross_reference"] = test_cross_reference_search()
        results["book_coverage"] = test_book_coverage()

        # Summary
        print("\n" + "="*80)
        print("TEST SUMMARY")
        print("="*80)

        for test_name, passed in results.items():
            status = "✓ PASS" if passed else "✗ FAIL"
            print(f"{status} - {test_name}")

        total_passed = sum(1 for p in results.values() if p)
        print(f"\nOverall: {total_passed}/{len(results)} tests passed")

        return 0 if total_passed == len(results) else 1

    except KeyboardInterrupt:
        print("\n\n⚠ Interrupted by user")
        return 1
    except Exception as e:
        print(f"\n✗ Error: {e}")
        import traceback
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
