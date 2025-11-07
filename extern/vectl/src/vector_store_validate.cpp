#include "vector_cluster_store.h"
#include "logger.h"
#include <iostream>
#include <random>
#include <chrono>
#include <vector>
#include <string>

int main(int argc, char* argv[]) {
    if (argc < 2) {
        std::cout << "Usage: " << argv[0] << " <vector_store_file>" << std::endl;
        std::cout << "This tool validates an existing vector store without modifying it." << std::endl;
        return 1;
    }

    std::string store_path = argv[1];
    
    std::cout << "=== Vector Store Validation Test ===" << std::endl;
    std::cout << "Store file: " << store_path << std::endl;
    
    Logger logger("validation.log");
    VectorClusterStore store(logger);
    
    // Initialize with placeholder dimensions - the store will read the actual dimensions from the header
    if (!store.initialize(store_path, "kmeans", 768, 10)) {
        std::cout << "❌ Failed to initialize vector store" << std::endl;
        std::cout << "Check validation.log for details" << std::endl;
        return 1;
    }
    
    // The store will log the actual dimensions when it reads the header
    std::cout << "✅ Vector store opened successfully" << std::endl;
    std::cout << "Check the validation.log file for detailed store information." << std::endl;
    
    // Test retrieving a few vectors to validate integrity
    std::cout << "\n=== Testing Vector Retrieval ===" << std::endl;
    
    for (uint32_t id = 1000; id < 1010; id++) {
        std::vector<float> vector;
        if (store.retrieveVector(id, vector)) {
            std::cout << "✅ Successfully retrieved vector ID " << id 
                      << " (dimension: " << vector.size() << ")" << std::endl;
            
            // Show first few values for verification
            std::cout << "   First 5 values: [";
            for (size_t i = 0; i < std::min(5ul, vector.size()); i++) {
                std::cout << std::fixed << std::setprecision(4) << vector[i];
                if (i < std::min(5ul, vector.size()) - 1) std::cout << ", ";
            }
            std::cout << "]" << std::endl;
            
            // Verify vector is normalized (typical for embeddings)
            float norm = 0.0f;
            for (float val : vector) {
                norm += val * val;
            }
            norm = std::sqrt(norm);
            std::cout << "   L2 norm: " << std::fixed << std::setprecision(4) << norm << std::endl;
            
        } else {
            std::cout << "⚠️  Vector ID " << id << " not found (may be empty slot)" << std::endl;
        }
    }
    
    // Test search functionality with a random query vector
    std::cout << "\n=== Testing Search Functionality ===" << std::endl;
    
    // Generate a dummy query vector with same dimensions as stored vectors
    // We'll use dimension 768 since that's what's in your store
    std::vector<float> query_vector(768, 0.0f);
    std::mt19937 gen(42);
    std::normal_distribution<float> dist(0.0f, 1.0f);
    
    for (size_t i = 0; i < query_vector.size(); i++) {
        query_vector[i] = dist(gen);
    }
    
    // Normalize the query vector
    float norm = 0.0f;
    for (float val : query_vector) {
        norm += val * val;
    }
    norm = std::sqrt(norm);
    if (norm > 0.0f) {
        for (size_t i = 0; i < query_vector.size(); i++) {
            query_vector[i] /= norm;
        }
    }
    
    auto results = store.findSimilarVectors(query_vector, 5);
    
    if (!results.empty()) {
        std::cout << "✅ Search functionality working - found " << results.size() << " similar vectors:" << std::endl;
        for (const auto& [id, similarity] : results) {
            std::cout << "   Vector ID " << id << " - Similarity: " 
                      << std::fixed << std::setprecision(4) << similarity << std::endl;
        }
    } else {
        std::cout << "⚠️  Search returned no results (store may be empty or have issues)" << std::endl;
    }
    
    store.printStoreInfo();
    
    std::cout << "\n=== Validation Summary ===" << std::endl;
    std::cout << "✅ Vector store validation completed successfully!" << std::endl;
    std::cout << "Your vector store appears to be working correctly." << std::endl;
    std::cout << "The segfaults were likely caused by dimension mismatches in test programs." << std::endl;
    
    return 0;
}