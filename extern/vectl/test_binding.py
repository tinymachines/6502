#!/usr/bin/env python3
import sys
import os

# Add the build directory to the path
sys.path.append(os.path.join(os.path.dirname(os.path.abspath(__file__)), "build"))

try:
    import vector_cluster_store_py
    print("Successfully imported vector_cluster_store_py")
    
    # Create a logger
    logger = vector_cluster_store_py.Logger("test.log")
    print("Created logger")
    
    # Create a vector store
    store = vector_cluster_store_py.VectorClusterStore(logger)
    print("Created vector store")
    
    print("Test completed successfully!")
except Exception as e:
    print(f"Error: {e}")
    import traceback
    traceback.print_exc()
