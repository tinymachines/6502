#ifndef CLUSTERING_INTERFACE_H
#define CLUSTERING_INTERFACE_H

#include <vector>
#include <cstdint>
#include <string>
#include <memory>
#include <unordered_map>
#include "logger.h"

// Forward declaration
class Logger;

// Vector type definition
using Vector = std::vector<float>;

// Cluster information structure
struct ClusterInfo {
    uint32_t cluster_id;
    Vector centroid;
    uint64_t start_offset;  // Byte offset on device where this cluster begins
    uint32_t vector_count;
    uint32_t capacity;      // Maximum vectors this cluster can hold
    
    // Serialization helpers
    std::vector<uint8_t> serialize() const;
    static ClusterInfo deserialize(const std::vector<uint8_t>& data);
};

// Vector entry information
struct VectorEntry {
    uint32_t vector_id;
    uint32_t cluster_id;
    uint64_t offset;       // Byte offset on device where this vector is stored
    
    // Metadata can be extended as needed
    std::string metadata;  // JSON string for flexible metadata
};

// Abstract base class for clustering strategies
class ClusteringStrategy {
public:
    virtual ~ClusteringStrategy() = default;
    
    // Initialize the clustering strategy
    virtual bool initialize(uint32_t vector_dim, uint32_t max_clusters) = 0;
    
    // Assign a vector to a cluster
    virtual uint32_t assignToCluster(const Vector& vector) = 0;
    
    // Add vector to the strategy's model (for strategies that learn over time)
    virtual bool addVector(const Vector& vector, uint32_t vector_id) = 0;
    
    // Remove vector from the strategy's model
    virtual bool removeVector(uint32_t vector_id) = 0;
    
    // Find N closest clusters to the query vector
    virtual std::vector<uint32_t> findClosestClusters(
        const Vector& query, uint32_t n) = 0;
    
    // Get centroid of a specific cluster
    virtual Vector getClusterCentroid(uint32_t cluster_id) = 0;
    
    // Get count of vectors in a cluster
    virtual uint32_t getClusterSize(uint32_t cluster_id) = 0;
    
    // Get all clusters
    virtual std::vector<ClusterInfo> getAllClusters() = 0;
    
    // Rebalance/update clusters if needed
    virtual bool rebalance() = 0;
    
    // Serialize the clustering model to a byte array
    virtual std::vector<uint8_t> serialize() = 0;
    
    // Deserialize the clustering model from a byte array
    virtual bool deserialize(const std::vector<uint8_t>& data) = 0;
    
    // Save model to a file
    virtual bool saveToFile(const std::string& filename) = 0;
    
    // Load model from a file
    virtual bool loadFromFile(const std::string& filename) = 0;
    
    // Name of the strategy (for logging/display)
    virtual std::string getName() const = 0;
};

// Factory function to create clustering strategies
std::shared_ptr<ClusteringStrategy> createClusteringStrategy(
    const std::string& strategy_name, 
    Logger& logger);

#endif // CLUSTERING_INTERFACE_H
