# Vector Store Python Package
from vector_cluster_store_py import VectorClusterStore, Logger

__version__ = '0.1.0'

# Convenience functions
def create_store(device_path, vector_dim=768, num_clusters=10, log_file="vector_store.log"):
    """
    Create and initialize a vector store.
    
    Args:
        device_path (str): Path to the device or file for storage
        vector_dim (int): Dimension of vectors to store
        num_clusters (int): Number of clusters to use
        log_file (str): Path to log file
    
    Returns:
        VectorClusterStore: Initialized vector store
    """
    logger = Logger(log_file)
    store = VectorClusterStore(logger)
    success = store.initialize(device_path, "kmeans", vector_dim, num_clusters)
    if not success:
        raise RuntimeError(f"Failed to initialize vector store at {device_path}")
    return store
