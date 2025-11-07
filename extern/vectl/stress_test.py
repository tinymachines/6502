#!/usr/bin/env python3

import sys
import os
import numpy as np
import time

# Import our vector store Python bindings
sys.path.append(os.path.join(os.path.dirname(os.path.abspath(__file__)), "build"))
import vector_cluster_store_py

def stress_test_store(store_path, num_vectors=100):
    """
    Stress test the vector store by rapidly adding vectors
    This might reproduce the corruption issue
    """
    print(f"🔥 Stress testing {store_path} with {num_vectors} vectors")
    
    logger = vector_cluster_store_py.Logger("stress_test.log")
    store = vector_cluster_store_py.VectorClusterStore(logger)
    
    # Initialize store
    if not store.initialize(store_path, "kmeans", 768, 10):
        print("❌ Failed to initialize store")
        return False
    
    print("✅ Store initialized")
    
    # Generate random vectors rapidly
    start_id = 10000  # Use high IDs to avoid conflicts
    success_count = 0
    fail_count = 0
    
    print(f"🚀 Adding {num_vectors} vectors rapidly...")
    start_time = time.time()
    
    for i in range(num_vectors):
        vector_id = start_id + i
        
        # Generate random normalized vector
        vector = np.random.normal(0, 1, 768)
        vector = vector / np.linalg.norm(vector)
        
        metadata = f'{{"test_vector": {i}, "stress_test": true, "timestamp": "{time.time()}"}}'
        
        try:
            if store.store_vector(vector_id, vector.tolist(), metadata):
                success_count += 1
                if (i + 1) % 10 == 0:
                    print(f"  Added {i + 1}/{num_vectors} vectors...")
            else:
                fail_count += 1
                print(f"❌ Failed to store vector {vector_id}")
                
                # Try to validate store after failure
                test_vector = []
                if store.retrieve_vector(vector_id - 1, test_vector):
                    print(f"✅ Previous vector {vector_id - 1} still readable")
                else:
                    print(f"❌ Previous vector {vector_id - 1} now corrupted!")
                    break
                    
        except Exception as e:
            print(f"❌ Exception storing vector {vector_id}: {e}")
            fail_count += 1
            break
    
    elapsed = time.time() - start_time
    print(f"\n📊 Stress test completed in {elapsed:.2f} seconds")
    print(f"✅ Successfully stored: {success_count}")
    print(f"❌ Failed to store: {fail_count}")
    
    # Final validation
    print(f"\n🔍 Validating a few random vectors...")
    test_ids = [start_id, start_id + 10, start_id + success_count - 1]
    
    for test_id in test_ids:
        test_vector = []
        if store.retrieve_vector(test_id, test_vector):
            print(f"✅ Vector {test_id} readable (dim: {len(test_vector)})")
        else:
            print(f"❌ Vector {test_id} corrupted/unreadable")
    
    return fail_count == 0

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python3 stress_test.py <vector_store_file>")
        sys.exit(1)
    
    store_path = sys.argv[1]
    success = stress_test_store(store_path, 50)  # Start with 50 vectors
    
    if success:
        print("🎉 Stress test passed - no corruption detected!")
    else:
        print("⚠️  Stress test failed - corruption may have occurred")