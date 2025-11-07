import vector_cluster_store_py

# Create a logger
logger = vector_cluster_store_py.Logger("vector_store.log")

# Create and initialize vector store
store = vector_cluster_store_py.VectorClusterStore(logger)
store.initialize("./vector_store.bin", "kmeans", 768, 10)

# Store a vector
vector_id = 0
vector = [0.1, 0.2, 0.3]  # Your embedding vector
metadata = "Example metadata"
store.store_vector(vector_id, vector, metadata)

# Retrieve a vector
retrieved_vector = store.retrieve_vector(vector_id)

# Find similar vectors
query_vector = [0.1, 0.2, 0.3]  # Query embedding
results = store.find_similar_vectors(query_vector, 5)  # Get top 5 matches
