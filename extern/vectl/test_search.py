#!/usr/bin/env python3
import sys
import os
import random

# Add the build directory to the path
sys.path.append(os.path.join(os.path.dirname(os.path.abspath(__file__)), "build"))

import vector_cluster_store_py
# Create a logger
logger = vector_cluster_store_py.Logger("vector_store.log")

# Create and initialize vector store
store = vector_cluster_store_py.VectorClusterStore(logger)
store.initialize("./vector_store.bin", "kmeans", 768, 10)

rvec = lambda: [ random.random() for i in range(0, 768) ]

# Store a vector
vector_id = 0
vector = rvec()  # Your embedding vector
metadata = "Example metadata"
store.store_vector(vector_id, vector, metadata)

# Retrieve a vector
retrieved_vector = store.retrieve_vector(vector_id)

# Find similar vectors
query_vector = rvec()  # Query embedding
results = store.find_similar_vectors(query_vector, 5)  # Get top 5 matches
