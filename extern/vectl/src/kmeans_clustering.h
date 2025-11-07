#ifndef KMEANS_CLUSTERING_H
#define KMEANS_CLUSTERING_H

#include "clustering_interface.h"
#include <random>
#include <unordered_map>
#include <set>

class Logger;

class KMeansClusteringStrategy : public ClusteringStrategy {
public:
    KMeansClusteringStrategy(Logger& logger);
    ~KMeansClusteringStrategy() override = default;
    
    bool initialize(uint32_t vector_dim, uint32_t max_clusters) override;
    uint32_t assignToCluster(const Vector& vector) override;
    bool addVector(const Vector& vector, uint32_t vector_id) override;
    bool removeVector(uint32_t vector_id) override;
    std::vector<uint32_t> findClosestClusters(const Vector& query, uint32_t n) override;
    Vector getClusterCentroid(uint32_t cluster_id) override;
    uint32_t getClusterSize(uint32_t cluster_id) override;
    std::vector<ClusterInfo> getAllClusters() override;
    bool rebalance() override;
    std::vector<uint8_t> serialize() override;
    bool deserialize(const std::vector<uint8_t>& data) override;
    bool saveToFile(const std::string& filename) override;
    bool loadFromFile(const std::string& filename) override;
    std::string getName() const override { return "K-means"; }

private:
    Logger& logger_;
    uint32_t vector_dim_;
    uint32_t max_clusters_;
    bool initialized_;
    
    // Cluster data
    std::unordered_map<uint32_t, Vector> centroids_;
    std::unordered_map<uint32_t, std::set<uint32_t>> cluster_members_;
    std::unordered_map<uint32_t, uint32_t> vector_to_cluster_;
    std::unordered_map<uint32_t, Vector> vectors_;
    
    // Cluster metadata
    std::unordered_map<uint32_t, ClusterInfo> cluster_info_;
    
    // Random number generator
    std::mt19937 rng_;
    
    // Internal methods
    float calculateDistance(const Vector& v1, const Vector& v2);
    uint32_t findClosestCentroid(const Vector& vector);
    void updateCentroid(uint32_t cluster_id);
    void initializeCentroids();
};

#endif // KMEANS_CLUSTERING_H
