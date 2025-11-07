#include "vector_cluster_store.h"
#include "logger.h"
#include <iostream>
#include <random>

int main(int argc, char* argv[]) {
    if (argc < 2) {
        std::cout << "Usage: " << argv[0] << " <vector_store_file>" << std::endl;
        return 1;
    }

    std::string store_path = argv[1];
    
    std::cout << "=== Corruption Detection Test ===" << std::endl;
    std::cout << "Testing store: " << store_path << std::endl;
    
    Logger logger("corruption_test.log");
    VectorClusterStore store(logger);
    
    // Test 1: Try to initialize
    std::cout << "\n🔍 Test 1: Initialization..." << std::endl;
    if (!store.initialize(store_path, "kmeans", 768, 10)) {
        std::cout << "❌ CORRUPTION DETECTED: Store failed to initialize" << std::endl;
        return 1;
    }
    std::cout << "✅ Store initialized successfully" << std::endl;
    
    // Test 2: Try to read high vector IDs (where corruption typically occurs)
    std::cout << "\n🔍 Test 2: Testing high vector IDs..." << std::endl;
    std::vector<uint32_t> test_ids = {1500, 2000, 2100, 2200, 2300, 2400, 2421};
    
    int successful_reads = 0;
    int failed_reads = 0;
    
    for (uint32_t vector_id : test_ids) {
        std::vector<float> vector;
        if (store.retrieveVector(vector_id, vector)) {
            if (vector.size() == 768) {
                std::cout << "✅ Vector " << vector_id << " read successfully (dim: " 
                          << vector.size() << ")" << std::endl;
                successful_reads++;
            } else {
                std::cout << "⚠️  Vector " << vector_id << " has wrong dimension: " 
                          << vector.size() << std::endl;
                failed_reads++;
            }
        } else {
            std::cout << "❌ Vector " << vector_id << " failed to read" << std::endl;
            failed_reads++;
        }
    }
    
    // Test 3: Try to add a new vector (this might trigger corruption)
    std::cout << "\n🔍 Test 3: Testing vector addition..." << std::endl;
    std::vector<float> test_vector(768, 0.1f);
    
    // Normalize the test vector
    float norm = 0.0f;
    for (float val : test_vector) {
        norm += val * val;
    }
    norm = std::sqrt(norm);
    for (size_t i = 0; i < test_vector.size(); i++) {
        test_vector[i] /= norm;
    }
    
    uint32_t test_id = 9999;
    if (store.storeVector(test_id, test_vector, "{\"test\": true}")) {
        std::cout << "✅ Successfully added test vector " << test_id << std::endl;
        
        // Try to read it back
        std::vector<float> retrieved_vector;
        if (store.retrieveVector(test_id, retrieved_vector)) {
            std::cout << "✅ Successfully retrieved test vector " << test_id << std::endl;
        } else {
            std::cout << "❌ Failed to retrieve test vector " << test_id << " after storage" << std::endl;
        }
    } else {
        std::cout << "❌ Failed to add test vector " << test_id << std::endl;
    }
    
    // Test 4: Search functionality stress test
    std::cout << "\n🔍 Test 4: Search functionality..." << std::endl;
    std::mt19937 gen(42);
    std::normal_distribution<float> dist(0.0f, 1.0f);
    
    std::vector<float> query_vector(768);
    for (size_t i = 0; i < query_vector.size(); i++) {
        query_vector[i] = dist(gen);
    }
    
    // Normalize query vector
    norm = 0.0f;
    for (float val : query_vector) {
        norm += val * val;
    }
    norm = std::sqrt(norm);
    for (size_t i = 0; i < query_vector.size(); i++) {
        query_vector[i] /= norm;
    }
    
    auto results = store.findSimilarVectors(query_vector, 10);
    
    std::cout << "Search returned " << results.size() << " results" << std::endl;
    for (const auto& [id, similarity] : results) {
        std::cout << "  Vector " << id << " - Similarity: " << similarity << std::endl;
    }
    
    std::cout << "\n=== Test Summary ===" << std::endl;
    std::cout << "Successful vector reads: " << successful_reads << std::endl;
    std::cout << "Failed vector reads: " << failed_reads << std::endl;
    
    if (failed_reads == 0) {
        std::cout << "🎉 NO CORRUPTION DETECTED - Store appears healthy!" << std::endl;
    } else {
        std::cout << "⚠️  POSSIBLE CORRUPTION - Some vectors failed to read" << std::endl;
    }
    
    return failed_reads > 0 ? 1 : 0;
}