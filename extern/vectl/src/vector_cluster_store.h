#ifndef VECTOR_CLUSTER_STORE_H
#define VECTOR_CLUSTER_STORE_H

#include "clustering_interface.h"
#include <string>
#include <memory>
#include <mutex>
#include <unordered_map>

class Logger;

class VectorClusterStore {
public:
    VectorClusterStore(Logger& logger);
    ~VectorClusterStore();
    
    // Initialize store with a device path and clustering strategy
    bool initialize(const std::string& device_path, 
                    const std::string& strategy_name,
                    uint32_t vector_dim,
                    uint32_t max_clusters = 100);
    
    // Open and close the device
    bool openDevice(bool readOnly = false);
    bool openDeviceWithDirectIO(bool readOnly = false);
    void closeDevice();
    
    // Store a vector with optional metadata
    bool storeVector(uint32_t vector_id, const Vector& vector, 
                    const std::string& metadata = "");
    
    // Retrieve a vector by ID
    bool retrieveVector(uint32_t vector_id, Vector& vector);
    
    // Get metadata for a vector by ID
    std::string getVectorMetadata(uint32_t vector_id);
    
    // Find similar vectors to the query
    std::vector<std::pair<uint32_t, float>> findSimilarVectors(
        const Vector& query, uint32_t k = 10);
    
    // Delete a vector by ID
    bool deleteVector(uint32_t vector_id);
    
    // Perform maintenance (rebalance clusters, optimize storage)
    bool performMaintenance();
    
    // Save and load index data
    bool saveIndex(const std::string& filename);
    bool loadIndex(const std::string& filename);
    
    // Debug information
    void printStoreInfo() const;
    void printClusterInfo(uint32_t cluster_id) const;
    
private:
    // Device handling
    int fd_;
    std::string device_path_;
    uint64_t device_size_;
    uint32_t block_size_;
    bool is_direct_io_;
    
    // Vector metadata
    uint32_t vector_dim_;
    uint32_t next_vector_id_;
    
    // Layout information
    uint64_t header_offset_;      // Store header
    uint64_t cluster_map_offset_; // Cluster metadata section
    uint64_t vector_map_offset_;  // Vector ID to location mapping
    uint64_t data_offset_;        // Start of actual vector data
    
    // In-memory data structures
    std::shared_ptr<ClusteringStrategy> clustering_;
    std::unordered_map<uint32_t, VectorEntry> vector_map_;
    std::mutex store_mutex_;
    Logger& logger_;
    
    // Signature for identifying our store format
    static constexpr char STORE_SIGNATURE[8] = {'V', 'C', 'S', 'T', 'O', 'R', 'E', '1'};
    
    // Header structure
    struct StoreHeader {
        char signature[8];      // VCSTOR1
        uint32_t version;       // Format version
        uint32_t vector_dim;    // Dimension of vectors
        uint32_t max_clusters;  // Maximum number of clusters
        uint32_t vector_count;  // Number of vectors stored
        uint32_t next_id;       // Next vector ID to assign
        uint64_t cluster_map_offset;
        uint64_t vector_map_offset;
        uint64_t data_offset;
        char strategy_name[32]; // Clustering strategy name
        uint8_t reserved[432];  // Reserved space (padding to 512 bytes)
    };
    
    // Internal methods
    bool readHeader();
    bool writeHeader();
    bool writeClusterMap();
    bool readClusterMap();
    bool writeVectorMap();
    bool readVectorMap();
    
    uint64_t allocateVectorSpace(uint32_t cluster_id);
    bool writeVector(uint64_t offset, const Vector& vector);
    bool readVector(uint64_t offset, Vector& vector);
    
    // Aligned I/O helpers
    void* allocateAlignedBuffer(size_t size);
    bool writeAligned(const void* buffer, size_t size, uint64_t offset);
    bool readAligned(void* buffer, size_t size, uint64_t offset);
    
    // Utility functions
    float calculateCosineSimilarity(const Vector& v1, const Vector& v2);
    static float calculateL2Distance(const Vector& v1, const Vector& v2);
};

#endif // VECTOR_CLUSTER_STORE_H
