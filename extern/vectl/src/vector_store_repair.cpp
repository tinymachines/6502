#include "vector_cluster_store.h"
#include "logger.h"
#include <iostream>
#include <fstream>
#include <cstring>

int main(int argc, char* argv[]) {
    if (argc < 3) {
        std::cout << "Vector Store Repair Tool" << std::endl;
        std::cout << "Usage: " << argv[0] << " <corrupted_store> <repaired_store>" << std::endl;
        std::cout << "This tool salvages readable vectors from a corrupted store." << std::endl;
        return 1;
    }

    std::string input_path = argv[1];
    std::string output_path = argv[2];
    
    std::cout << "=== Vector Store Repair Tool ===" << std::endl;
    std::cout << "Input:  " << input_path << std::endl;
    std::cout << "Output: " << output_path << std::endl;
    
    // Step 1: Try to read as many vectors as possible from corrupted store
    Logger logger("repair.log");
    VectorClusterStore corrupted_store(logger);
    
    std::cout << "\n📖 Reading corrupted store..." << std::endl;
    
    // Try to initialize the corrupted store
    if (!corrupted_store.initialize(input_path, "kmeans", 768, 10)) {
        std::cout << "❌ Could not read any data from corrupted store" << std::endl;
        return 1;
    }
    
    // Get store info to see what we can salvage
    corrupted_store.printStoreInfo();
    
    std::cout << "\n🔧 Creating new repaired store..." << std::endl;
    
    // Step 2: Create new store for repaired data
    VectorClusterStore repaired_store(logger);
    if (!repaired_store.initialize(output_path, "kmeans", 768, 10)) {
        std::cout << "❌ Failed to create repaired store" << std::endl;
        return 1;
    }
    
    std::cout << "\n📋 Copying readable vectors..." << std::endl;
    
    // Step 3: Copy all readable vectors to new store
    uint32_t copied_count = 0;
    uint32_t failed_count = 0;
    
    // Try to copy vectors starting from reasonable IDs
    // Based on your metadata, vectors start around ID 1000
    for (uint32_t vector_id = 1000; vector_id < 3000; vector_id++) {
        std::vector<float> vector;
        
        if (corrupted_store.retrieveVector(vector_id, vector)) {
            if (vector.size() == 768) {
                // Generate simple metadata for the copied vector
                std::string metadata = "{\"vector_id\":" + std::to_string(vector_id) + 
                                     ",\"recovered\":true" +
                                     ",\"original_corruption\":true}";
                
                if (repaired_store.storeVector(vector_id, vector, metadata)) {
                    copied_count++;
                    if (copied_count % 100 == 0) {
                        std::cout << "✅ Copied " << copied_count << " vectors..." << std::endl;
                    }
                } else {
                    failed_count++;
                }
            }
        } else {
            // If we hit too many failures in a row, stop
            failed_count++;
            if (failed_count > 100 && copied_count > 0) {
                break;
            }
        }
    }
    
    std::cout << "\n=== Repair Summary ===" << std::endl;
    std::cout << "✅ Successfully copied: " << copied_count << " vectors" << std::endl;
    std::cout << "❌ Failed/corrupted: " << failed_count << " vectors" << std::endl;
    
    if (copied_count > 0) {
        std::cout << "\n🎉 Repair completed successfully!" << std::endl;
        std::cout << "Your repaired store is saved as: " << output_path << std::endl;
        std::cout << "\nTo verify the repair worked:" << std::endl;
        std::cout << "  ./build/vector_store_validate " << output_path << std::endl;
        std::cout << "\nTo use with your Python application:" << std::endl;
        std::cout << "  python3 ollama_vector_search.py " << output_path << std::endl;
        
        return 0;
    } else {
        std::cout << "\n❌ No vectors could be recovered from the corrupted store" << std::endl;
        return 1;
    }
}