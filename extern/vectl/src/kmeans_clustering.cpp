#include "kmeans_clustering.h"
#include <cmath>
#include <algorithm>
#include <fstream>
#include <iostream>
#include <numeric>
#include <limits>
#include <cassert>
#include <random>
#include <chrono>
#include <sstream>
#include <cstring>

// Assuming Logger class is implemented elsewhere, just use simple logging here
class Logger; // This would normally be included from a header

KMeansClusteringStrategy::KMeansClusteringStrategy(Logger& logger)
    : logger_(logger), vector_dim_(0), max_clusters_(0), initialized_(false) {
    // Initialize random number generator with time-based seed
    rng_.seed(static_cast<uint32_t>(std::chrono::system_clock::now().time_since_epoch().count()));
}

bool KMeansClusteringStrategy::initialize(uint32_t vector_dim, uint32_t max_clusters) {
    vector_dim_ = vector_dim;
    max_clusters_ = max_clusters;
    
    // Clear any existing data
    centroids_.clear();
    cluster_members_.clear();
    vector_to_cluster_.clear();
    vectors_.clear();
    cluster_info_.clear();
    
    // Will initialize centroids once we have some vectors
    initialized_ = true;
    
    // Initialize with empty clusters
    for (uint32_t i = 0; i < max_clusters_; i++) {
        ClusterInfo info;
        info.cluster_id = i;
        info.centroid.resize(vector_dim_, 0.0f);
        info.start_offset = 0;  // Will be assigned by the storage layer
        info.vector_count = 0;
        info.capacity = 1000;   // Default capacity, can be adjusted
        
        cluster_info_[i] = info;
        cluster_members_[i] = std::set<uint32_t>();
        centroids_[i] = Vector(vector_dim_, 0.0f);
    }
    
    return true;
}

uint32_t KMeansClusteringStrategy::assignToCluster(const Vector& vector) {
    if (!initialized_) {
        // If not initialized, initialize with random centroids
        initializeCentroids();
    }
    
    // Find closest centroid
    return findClosestCentroid(vector);
}

bool KMeansClusteringStrategy::addVector(const Vector& vector, uint32_t vector_id) {
    if (!initialized_) {
        // If not initialized, initialize with random centroids
        initializeCentroids();
    }
    
    // Store vector
    vectors_[vector_id] = vector;
    
    // Assign to cluster
    uint32_t cluster_id = findClosestCentroid(vector);
    
    // Update mappings
    vector_to_cluster_[vector_id] = cluster_id;
    cluster_members_[cluster_id].insert(vector_id);
    
    // Update cluster info
    cluster_info_[cluster_id].vector_count++;
    
    // Update centroid
    updateCentroid(cluster_id);
    
    return true;
}

bool KMeansClusteringStrategy::removeVector(uint32_t vector_id) {
    if (vector_to_cluster_.find(vector_id) == vector_to_cluster_.end()) {
        return false;  // Vector not found
    }
    
    uint32_t cluster_id = vector_to_cluster_[vector_id];
    
    // Remove from mappings
    vector_to_cluster_.erase(vector_id);
    cluster_members_[cluster_id].erase(vector_id);
    vectors_.erase(vector_id);
    
    // Update cluster info
    cluster_info_[cluster_id].vector_count--;
    
    // Update centroid
    updateCentroid(cluster_id);
    
    return true;
}

std::vector<uint32_t> KMeansClusteringStrategy::findClosestClusters(const Vector& query, uint32_t n) {
    std::vector<std::pair<uint32_t, float>> distances;
    
    // Calculate distance to each centroid
    for (const auto& [cluster_id, centroid] : centroids_) {
        float distance = calculateDistance(query, centroid);
        distances.push_back({cluster_id, distance});
    }
    
    // Sort by distance (closest first)
    std::sort(distances.begin(), distances.end(), 
              [](const auto& a, const auto& b) { return a.second < b.second; });
    
    // Take top n
    std::vector<uint32_t> result;
    for (size_t i = 0; i < n && i < distances.size(); i++) {
        result.push_back(distances[i].first);
    }
    
    return result;
}

Vector KMeansClusteringStrategy::getClusterCentroid(uint32_t cluster_id) {
    if (centroids_.find(cluster_id) == centroids_.end()) {
        return Vector(vector_dim_, 0.0f);  // Return zero vector if not found
    }
    return centroids_[cluster_id];
}

uint32_t KMeansClusteringStrategy::getClusterSize(uint32_t cluster_id) {
    if (cluster_members_.find(cluster_id) == cluster_members_.end()) {
        return 0;
    }
    return static_cast<uint32_t>(cluster_members_[cluster_id].size());
}

std::vector<ClusterInfo> KMeansClusteringStrategy::getAllClusters() {
    std::vector<ClusterInfo> result;
    for (const auto& [cluster_id, info] : cluster_info_) {
        // Update centroid in info
        ClusterInfo updated_info = info;
        updated_info.centroid = centroids_[cluster_id];
        result.push_back(updated_info);
    }
    return result;
}

bool KMeansClusteringStrategy::rebalance() {
    // Full K-means iteration
    bool changed = false;
    std::unordered_map<uint32_t, uint32_t> new_assignments;
    
    // Assign each vector to closest centroid
    for (const auto& [vector_id, vector] : vectors_) {
        uint32_t new_cluster = findClosestCentroid(vector);
        new_assignments[vector_id] = new_cluster;
        
        if (vector_to_cluster_[vector_id] != new_cluster) {
            changed = true;
        }
    }
    
    if (!changed) {
        return false;  // No changes, already balanced
    }
    
    // Apply new assignments
    for (const auto& [vector_id, new_cluster] : new_assignments) {
        uint32_t old_cluster = vector_to_cluster_[vector_id];
        
        if (old_cluster != new_cluster) {
            // Remove from old cluster
            cluster_members_[old_cluster].erase(vector_id);
            cluster_info_[old_cluster].vector_count--;
            
            // Add to new cluster
            cluster_members_[new_cluster].insert(vector_id);
            cluster_info_[new_cluster].vector_count++;
            
            // Update mapping
            vector_to_cluster_[vector_id] = new_cluster;
        }
    }
    
    // Update all centroids
    for (const auto& [cluster_id, _] : centroids_) {
        updateCentroid(cluster_id);
    }
    
    return true;
}

std::vector<uint8_t> KMeansClusteringStrategy::serialize() {
    // Simple binary serialization
    std::vector<uint8_t> result;
    
    // Add vector_dim and max_clusters
    result.resize(2 * sizeof(uint32_t));
    memcpy(result.data(), &vector_dim_, sizeof(uint32_t));
    memcpy(result.data() + sizeof(uint32_t), &max_clusters_, sizeof(uint32_t));
    
    // Add number of vectors
    uint32_t num_vectors = static_cast<uint32_t>(vectors_.size());
    size_t pos = 2 * sizeof(uint32_t);
    result.resize(pos + sizeof(uint32_t));
    memcpy(result.data() + pos, &num_vectors, sizeof(uint32_t));
    pos += sizeof(uint32_t);
    
    // Add vectors and their assignments
    for (const auto& [vector_id, vector] : vectors_) {
        // Resize to fit vector_id, cluster_id, and vector data
        size_t new_size = pos + 2 * sizeof(uint32_t) + vector.size() * sizeof(float);
        result.resize(new_size);
        
        // Add vector_id
        memcpy(result.data() + pos, &vector_id, sizeof(uint32_t));
        pos += sizeof(uint32_t);
        
        // Add cluster_id
        uint32_t cluster_id = vector_to_cluster_[vector_id];
        memcpy(result.data() + pos, &cluster_id, sizeof(uint32_t));
        pos += sizeof(uint32_t);
        
        // Add vector data
        memcpy(result.data() + pos, vector.data(), vector.size() * sizeof(float));
        pos += vector.size() * sizeof(float);
    }
    
    // Add cluster info
    uint32_t num_clusters = static_cast<uint32_t>(cluster_info_.size());
    result.resize(pos + sizeof(uint32_t));
    memcpy(result.data() + pos, &num_clusters, sizeof(uint32_t));
    pos += sizeof(uint32_t);
    
    for (const auto& [cluster_id, info] : cluster_info_) {
        // Add cluster_id
        result.resize(pos + sizeof(uint32_t));
        memcpy(result.data() + pos, &cluster_id, sizeof(uint32_t));
        pos += sizeof(uint32_t);
        
        // Add ClusterInfo
        const auto& serialized = info.serialize();
        result.resize(pos + serialized.size());
        memcpy(result.data() + pos, serialized.data(), serialized.size());
        pos += serialized.size();
    }
    
    return result;
}


bool KMeansClusteringStrategy::deserialize(const std::vector<uint8_t>& data) {
    if (data.size() < 2 * sizeof(uint32_t)) {
        return false;  // Not enough data
    }
    
    // Extract vector_dim and max_clusters
    memcpy(&vector_dim_, data.data(), sizeof(uint32_t));
    memcpy(&max_clusters_, data.data() + sizeof(uint32_t), sizeof(uint32_t));
    
    // Clear existing data
    centroids_.clear();
    cluster_members_.clear();
    vector_to_cluster_.clear();
    vectors_.clear();
    cluster_info_.clear();
    
    // Extract number of vectors
    size_t pos = 2 * sizeof(uint32_t);
    uint32_t num_vectors;
    memcpy(&num_vectors, data.data() + pos, sizeof(uint32_t));
    pos += sizeof(uint32_t);
    
    // Extract vectors and their assignments
    for (uint32_t i = 0; i < num_vectors; i++) {
        // Extract vector_id
        uint32_t vector_id;
        memcpy(&vector_id, data.data() + pos, sizeof(uint32_t));
        pos += sizeof(uint32_t);
        
        // Extract cluster_id
        uint32_t cluster_id;
        memcpy(&cluster_id, data.data() + pos, sizeof(uint32_t));
        pos += sizeof(uint32_t);
        
        // Extract vector data
        Vector vector(vector_dim_);
        memcpy(vector.data(), data.data() + pos, vector_dim_ * sizeof(float));
        pos += vector_dim_ * sizeof(float);
        
        // Store vector and assignment
        vectors_[vector_id] = vector;
        vector_to_cluster_[vector_id] = cluster_id;
        
        // Ensure cluster exists
        if (cluster_members_.find(cluster_id) == cluster_members_.end()) {
            cluster_members_[cluster_id] = std::set<uint32_t>();
            centroids_[cluster_id] = Vector(vector_dim_, 0.0f);
        }
        
        // Add to cluster
        cluster_members_[cluster_id].insert(vector_id);
    }
    
    // Extract number of clusters
    uint32_t num_clusters;
    memcpy(&num_clusters, data.data() + pos, sizeof(uint32_t));
    pos += sizeof(uint32_t);
    
    // Extract cluster info
    for (uint32_t i = 0; i < num_clusters; i++) {
        // Extract cluster_id
        uint32_t cluster_id;
        memcpy(&cluster_id, data.data() + pos, sizeof(uint32_t));
        pos += sizeof(uint32_t);
        
        // Extract serialized ClusterInfo
        std::vector<uint8_t> serialized_info(data.begin() + pos, data.end());
        ClusterInfo info = ClusterInfo::deserialize(serialized_info);
        
        // Store cluster info
        cluster_info_[cluster_id] = info;
        
        // Skip to next cluster
        pos += serialized_info.size();
    }
    
    // Update centroids
    for (const auto& [cluster_id, _] : cluster_info_) {
        updateCentroid(cluster_id);
    }
    
    initialized_ = true;
    return true;
}

bool KMeansClusteringStrategy::saveToFile(const std::string& filename) {
    std::vector<uint8_t> serialized = serialize();
    std::ofstream file(filename, std::ios::binary);
    if (!file.is_open()) {
        return false;
    }
    
    file.write(reinterpret_cast<const char*>(serialized.data()), serialized.size());
    return !file.bad();
}

bool KMeansClusteringStrategy::loadFromFile(const std::string& filename) {
    std::ifstream file(filename, std::ios::binary | std::ios::ate);
    if (!file.is_open()) {
        return false;
    }
    
    std::streamsize size = file.tellg();
    file.seekg(0, std::ios::beg);
    
    std::vector<uint8_t> serialized(size);
    if (!file.read(reinterpret_cast<char*>(serialized.data()), size)) {
        return false;
    }
    
    return deserialize(serialized);
}

float KMeansClusteringStrategy::calculateDistance(const Vector& v1, const Vector& v2) {
    float sum = 0.0f;
    for (size_t i = 0; i < v1.size(); i++) {
        float diff = v1[i] - v2[i];
        sum += diff * diff;
    }
    return std::sqrt(sum);
}

uint32_t KMeansClusteringStrategy::findClosestCentroid(const Vector& vector) {
    uint32_t closest_id = 0;
    float min_distance = std::numeric_limits<float>::max();
    
    for (const auto& [cluster_id, centroid] : centroids_) {
        float distance = calculateDistance(vector, centroid);
        if (distance < min_distance) {
            min_distance = distance;
            closest_id = cluster_id;
        }
    }
    
    return closest_id;
}

void KMeansClusteringStrategy::updateCentroid(uint32_t cluster_id) {
    const auto& members = cluster_members_[cluster_id];
    
    // If cluster is empty, leave centroid as is
    if (members.empty()) {
        return;
    }
    
    // Calculate average of all vectors in cluster
    Vector new_centroid(vector_dim_, 0.0f);
    
    for (uint32_t vector_id : members) {
        const auto& vector = vectors_[vector_id];
        for (size_t i = 0; i < vector_dim_; i++) {
            new_centroid[i] += vector[i];
        }
    }
    
    for (size_t i = 0; i < vector_dim_; i++) {
        new_centroid[i] /= members.size();
    }
    
    // Update centroid
    centroids_[cluster_id] = new_centroid;
    
    // Update cluster info
    if (cluster_info_.find(cluster_id) != cluster_info_.end()) {
        cluster_info_[cluster_id].centroid = new_centroid;
    }
}

void KMeansClusteringStrategy::initializeCentroids() {
    // If we have vectors, initialize centroids with random vectors
    if (!vectors_.empty()) {
        std::vector<uint32_t> vector_ids;
        for (const auto& [vector_id, _] : vectors_) {
            vector_ids.push_back(vector_id);
        }
        
        // Shuffle vector IDs
        std::shuffle(vector_ids.begin(), vector_ids.end(), rng_);
        
        // Take first max_clusters_ vectors as initial centroids
        for (uint32_t i = 0; i < max_clusters_ && i < vector_ids.size(); i++) {
            centroids_[i] = vectors_[vector_ids[i]];
        }
        
        // For any remaining clusters, initialize with random values
        for (uint32_t i = static_cast<uint32_t>(vector_ids.size()); i < max_clusters_; i++) {
            Vector random_centroid(vector_dim_);
            for (size_t j = 0; j < vector_dim_; j++) {
                random_centroid[j] = static_cast<float>(std::uniform_real_distribution<>(-1.0, 1.0)(rng_));
            }
            centroids_[i] = random_centroid;
        }
    } else {
        // Initialize with random centroids
        for (uint32_t i = 0; i < max_clusters_; i++) {
            Vector random_centroid(vector_dim_);
            for (size_t j = 0; j < vector_dim_; j++) {
                random_centroid[j] = static_cast<float>(std::uniform_real_distribution<>(-1.0, 1.0)(rng_));
            }
            centroids_[i] = random_centroid;
        }
    }
    
    // Initialize cluster members
    for (uint32_t i = 0; i < max_clusters_; i++) {
        cluster_members_[i] = std::set<uint32_t>();
    }
    
    initialized_ = true;
}

// Implementation of ClusterInfo serialization methods

std::vector<uint8_t> ClusterInfo::serialize() const {
    std::vector<uint8_t> result;
    
    // Calculate size needed (use quantized centroids for compression)
    size_t base_size = 4 * sizeof(uint32_t) + sizeof(uint64_t);
    
    // Serialize basic data first
    result.resize(base_size);
    size_t pos = 0;
    
    // Add cluster_id
    memcpy(result.data() + pos, &cluster_id, sizeof(uint32_t));
    pos += sizeof(uint32_t);
    
    // Add vector_count
    memcpy(result.data() + pos, &vector_count, sizeof(uint32_t));
    pos += sizeof(uint32_t);
    
    // Add capacity
    memcpy(result.data() + pos, &capacity, sizeof(uint32_t));
    pos += sizeof(uint32_t);
    
    // Add start_offset
    memcpy(result.data() + pos, &start_offset, sizeof(uint64_t));
    pos += sizeof(uint64_t);
    
    // Add centroid dimension
    uint32_t centroid_dim = static_cast<uint32_t>(centroid.size());
    memcpy(result.data() + pos, &centroid_dim, sizeof(uint32_t));
    pos += sizeof(uint32_t);
    
    // For centroids, we'll use 16-bit quantization to save space
    std::vector<int16_t> quantized_centroid;
    float scale = 0.0f;
    
    // Find scale factor (max absolute value)
    for (const auto& val : centroid) {
        scale = std::max(scale, std::fabs(val));
    }
    
    // Use a small epsilon to avoid division by zero
    scale = (scale < 1e-10f) ? 1.0f : scale / 32767.0f;
    
    // Quantize centroid to 16-bit integers
    quantized_centroid.resize(centroid_dim);
    for (size_t i = 0; i < centroid_dim; i++) {
        quantized_centroid[i] = static_cast<int16_t>(std::round(centroid[i] / scale));
    }
    
    // Add scale factor
    result.resize(pos + sizeof(float));
    memcpy(result.data() + pos, &scale, sizeof(float));
    pos += sizeof(float);
    
    // Add quantized centroid data
    result.resize(pos + quantized_centroid.size() * sizeof(int16_t));
    memcpy(result.data() + pos, quantized_centroid.data(), quantized_centroid.size() * sizeof(int16_t));
    
    return result;
}

ClusterInfo ClusterInfo::deserialize(const std::vector<uint8_t>& data) {
    ClusterInfo info;
    size_t pos = 0;
    
    // Extract cluster_id
    memcpy(&info.cluster_id, data.data() + pos, sizeof(uint32_t));
    pos += sizeof(uint32_t);
    
    // Extract vector_count
    memcpy(&info.vector_count, data.data() + pos, sizeof(uint32_t));
    pos += sizeof(uint32_t);
    
    // Extract capacity
    memcpy(&info.capacity, data.data() + pos, sizeof(uint32_t));
    pos += sizeof(uint32_t);
    
    // Extract start_offset
    memcpy(&info.start_offset, data.data() + pos, sizeof(uint64_t));
    pos += sizeof(uint64_t);
    
    // Extract centroid dimension
    uint32_t centroid_dim;
    memcpy(&centroid_dim, data.data() + pos, sizeof(uint32_t));
    pos += sizeof(uint32_t);
    
    // Extract scale factor
    float scale;
    memcpy(&scale, data.data() + pos, sizeof(float));
    pos += sizeof(float);
    
    // Extract quantized centroid data
    std::vector<int16_t> quantized_centroid(centroid_dim);
    memcpy(quantized_centroid.data(), data.data() + pos, centroid_dim * sizeof(int16_t));
    
    // Dequantize centroid
    info.centroid.resize(centroid_dim);
    for (size_t i = 0; i < centroid_dim; i++) {
        info.centroid[i] = quantized_centroid[i] * scale;
    }
    
    return info;
}
/*std::vector<uint8_t> ClusterInfo::serialize() const {
    std::vector<uint8_t> result;
    
    // Calculate size needed
    size_t size = 4 * sizeof(uint32_t) + sizeof(uint64_t) + centroid.size() * sizeof(float);
    result.resize(size);
    
    size_t pos = 0;
    
    // Add cluster_id
    memcpy(result.data() + pos, &cluster_id, sizeof(uint32_t));
    pos += sizeof(uint32_t);
    
    // Add vector_count
    memcpy(result.data() + pos, &vector_count, sizeof(uint32_t));
    pos += sizeof(uint32_t);
    
    // Add capacity
    memcpy(result.data() + pos, &capacity, sizeof(uint32_t));
    pos += sizeof(uint32_t);
    
    // Add start_offset
    memcpy(result.data() + pos, &start_offset, sizeof(uint64_t));
    pos += sizeof(uint64_t);
    
    // Add centroid dimension
    uint32_t centroid_dim = static_cast<uint32_t>(centroid.size());
    memcpy(result.data() + pos, &centroid_dim, sizeof(uint32_t));
    pos += sizeof(uint32_t);
    
    // Add centroid data
    memcpy(result.data() + pos, centroid.data(), centroid.size() * sizeof(float));
    
    return result;
}

ClusterInfo ClusterInfo::deserialize(const std::vector<uint8_t>& data) {
    ClusterInfo info;
    size_t pos= 0;
    
    // Extract cluster_id
    memcpy(&info.cluster_id, data.data() + pos, sizeof(uint32_t));
    pos += sizeof(uint32_t);
    
    // Extract vector_count
    memcpy(&info.vector_count, data.data() + pos, sizeof(uint32_t));
    pos += sizeof(uint32_t);
    
    // Extract capacity
    memcpy(&info.capacity, data.data() + pos, sizeof(uint32_t));
    pos += sizeof(uint32_t);
    
    // Extract start_offset
    memcpy(&info.start_offset, data.data() + pos, sizeof(uint64_t));
    pos += sizeof(uint64_t);
    
    // Extract centroid dimension
    uint32_t centroid_dim;
    memcpy(&centroid_dim, data.data() + pos, sizeof(uint32_t));
    pos += sizeof(uint32_t);
    
    // Extract centroid data
    info.centroid.resize(centroid_dim);
    memcpy(info.centroid.data(), data.data() + pos, centroid_dim * sizeof(float));
    
    return info;
}*/

// Factory function implementation
std::shared_ptr<ClusteringStrategy> createClusteringStrategy(
    const std::string& strategy_name, 
    Logger& logger) {
    
    if (strategy_name == "kmeans") {
        return std::make_shared<KMeansClusteringStrategy>(logger);
    }
    
    // Add more clustering strategies here
    
    // Default to K-means
    return std::make_shared<KMeansClusteringStrategy>(logger);
}
