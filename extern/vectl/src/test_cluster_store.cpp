#include "vector_cluster_store.h"
#include <iostream>
#include <random>
#include <chrono>
#include <iomanip>
#include <algorithm>
#include <fstream>
#include "logger.h"
// Simple logger implementation for testing
/*class Logger {
public:
    Logger(const std::string& filename) : filename_(filename) {
        file_.open(filename, std::ios::out | std::ios::app);
    }
    
    ~Logger() {
        if (file_.is_open()) {
            file_.close();
        }
    }
    
    void debug(const std::string& message) {
        log("DEBUG", message);
    }
    
    void info(const std::string& message) {
        log("INFO", message);
    }
    
    void warning(const std::string& message) {
        log("WARNING", message);
    }
    
    void error(const std::string& message) {
        log("ERROR", message);
    }
    
private:
    std::string filename_;
    std::ofstream file_;
    
    void log(const std::string& level, const std::string& message) {
        std::string timestamp = getCurrentTimestamp();
        std::string log_entry = timestamp + " [" + level + "] " + message;
        
        if (file_.is_open()) {
            file_ << log_entry << std::endl;
        }
        
        std::cout << log_entry << std::endl;
    }
    
    std::string getCurrentTimestamp() {
        auto now = std::chrono::system_clock::now();
        auto now_c = std::chrono::system_clock::to_time_t(now);
        auto now_tm = std::localtime(&now_c);
        
        std::stringstream ss;
        ss << std::put_time(now_tm, "%Y-%m-%d %H:%M:%S");
        return ss.str();
    }
};*/

// Generate random vectors
std::vector<Vector> generateRandomVectors(size_t count, size_t dim, unsigned int seed = 42) {
    std::mt19937 gen(seed);
    std::normal_distribution<float> dist(0.0f, 1.0f);
    
    std::vector<Vector> vectors;
    for (size_t i = 0; i < count; i++) {
        Vector vec(dim);
        for (size_t j = 0; j < dim; j++) {
            vec[j] = dist(gen);
        }
        
        // Normalize
        float norm = 0.0f;
        for (float val : vec) {
            norm += val * val;
        }
        norm = std::sqrt(norm);
        
        if (norm > 0.0f) {
            for (size_t j = 0; j < dim; j++) {
                vec[j] /= norm;
            }
        }
        
        vectors.push_back(vec);
    }
    
    return vectors;
}

// Generate vectors in clusters
std::vector<std::pair<Vector, uint32_t>> generateClusteredVectors(size_t count, 
                                                                size_t dim, 
                                                                size_t num_clusters, 
                                                                unsigned int seed = 42) {
    std::mt19937 gen(seed);
    std::normal_distribution<float> centroid_dist(0.0f, 10.0f);
    std::normal_distribution<float> offset_dist(0.0f, 0.2f);
    
    // Generate cluster centroids
    std::vector<Vector> centroids;
    for (size_t i = 0; i < num_clusters; i++) {
        Vector centroid(dim);
        for (size_t j = 0; j < dim; j++) {
            centroid[j] = centroid_dist(gen);
        }
        centroids.push_back(centroid);
    }
    
    // Generate vectors around centroids
    std::vector<std::pair<Vector, uint32_t>> vectors;
    std::uniform_int_distribution<size_t> cluster_dist(0, num_clusters - 1);
    
    for (size_t i = 0; i < count; i++) {
        size_t cluster_idx = i % num_clusters; // Distribute evenly
        
        const auto& centroid = centroids[cluster_idx];
        Vector vec(dim);
        
        for (size_t j = 0; j < dim; j++) {
            vec[j] = centroid[j] + offset_dist(gen);
        }
        
        // Normalize
        float norm = 0.0f;
        for (float val : vec) {
            norm += val * val;
        }
        norm = std::sqrt(norm);
        
        if (norm > 0.0f) {
            for (size_t j = 0; j < dim; j++) {
                vec[j] /= norm;
            }
        }
        
        vectors.push_back({vec, static_cast<uint32_t>(cluster_idx)});
    }
    
    return vectors;
}

void displayVector(const Vector& vec, size_t max_values = 5) {
    std::cout << "[";
    for (size_t i = 0; i < std::min(max_values, vec.size()); i++) {
        std::cout << std::fixed << std::setprecision(4) << vec[i];
        if (i < std::min(max_values, vec.size()) - 1) {
            std::cout << ", ";
        }
    }
    if (vec.size() > max_values) {
        std::cout << ", ...";
    }
    std::cout << "]";
}

int main(int argc, char* argv[]) {
    if (argc < 2) {
        std::cout << "Usage: " << argv[0] << " <device_path>" << std::endl;
        return 1;
    }
    
    std::string device_path = argv[1];
    
    // Initialize logger
    Logger logger("vector_store_test.log");
    logger.info("Vector Cluster Store Test started");
    
    // Initialize store
    VectorClusterStore store(logger);
    
    // Parameters
    const uint32_t vector_dim = 768;      // 128-dimensional vectors
    const uint32_t num_clusters = 10;     // 10 clusters
    const size_t num_vectors = 100;   // 100 vectors
    
    // Initialize store
    if (!store.initialize(device_path, "kmeans", vector_dim, num_clusters)) {
        logger.error("Failed to initialize store");
        return 1;
    }
    
    // Generate test vectors (clustered)
    logger.info("Generating " + std::to_string(num_vectors) + " test vectors");
    auto clustered_vectors = generateClusteredVectors(num_vectors, vector_dim, num_clusters);
    
    // Store vectors
    logger.info("Storing vectors...");
    for (size_t i = 0; i < clustered_vectors.size(); i++) {
        const auto& [vector, cluster_id] = clustered_vectors[i];
        
        // Generate metadata
        std::string metadata = "Cluster: " + std::to_string(cluster_id) + 
                              ", Index: " + std::to_string(i);
        
        // Store vector
        if (!store.storeVector(static_cast<uint32_t>(i), vector, metadata)) {
            logger.error("Failed to store vector " + std::to_string(i));
        }
    }
    
    // Print store info
    store.printStoreInfo();
    
    // Test retrieval
    logger.info("Testing vector retrieval...");
    for (uint32_t i = 0; i < 5; i++) {
        Vector retrieved;
        if (store.retrieveVector(i, retrieved)) {
            std::cout << "Vector " << i << ": ";
            displayVector(retrieved);
            std::cout << std::endl;
        } else {
            logger.error("Failed to retrieve vector " + std::to_string(i));
        }
    }
    
    // Test similarity search
    logger.info("Testing similarity search...");
    for (uint32_t i = 0; i < 3; i++) {
        const auto& [query, _] = clustered_vectors[i];
        
        std::cout << "Query vector " << i << ": ";
        displayVector(query);
        std::cout << std::endl;
        
        auto results = store.findSimilarVectors(query, 5);
        
        std::cout << "Results:" << std::endl;
        for (const auto& [id, similarity] : results) {
            std::cout << "  ID: " << id << ", Similarity: " << std::fixed << 
                std::setprecision(4) << similarity << std::endl;
        }
        std::cout << std::endl;
    }
    
    // Test cluster maintenance
    logger.info("Testing cluster maintenance...");
    if (store.performMaintenance()) {
        logger.info("Maintenance completed successfully");
    } else {
        logger.error("Maintenance failed");
    }
    
    // Show cluster info
    for (uint32_t i = 0; i < 3; i++) {
        store.printClusterInfo(i);
    }
    
    // Test index save/load
    logger.info("Testing index save/load...");
    if (store.saveIndex("vector_store_index")) {
        logger.info("Index saved successfully");
    } else {
        logger.error("Failed to save index");
    }
    
    logger.info("Vector Cluster Store Test completed");
    
    return 0;
}
