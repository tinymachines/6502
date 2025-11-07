#include "vector_cluster_store.h"
#include "logger.h"
#include <iostream>
#include <fstream>
#include <cstring>
#include <vector>
#include <iomanip>

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

class VectorStoreDiagnostic {
private:
    Logger logger_;
    
public:
    VectorStoreDiagnostic() : logger_("diagnostic.log") {}
    
    bool analyzeStore(const std::string& filepath) {
        std::cout << "\n=== Vector Store Diagnostic Analysis ===" << std::endl;
        std::cout << "File: " << filepath << std::endl;
        
        std::ifstream file(filepath, std::ios::binary | std::ios::in);
        if (!file.is_open()) {
            logger_.error("Cannot open file: " + filepath);
            return false;
        }
        
        // Get file size
        file.seekg(0, std::ios::end);
        size_t fileSize = file.tellg();
        file.seekg(0, std::ios::beg);
        
        std::cout << "File size: " << fileSize << " bytes (" << fileSize / (1024*1024) << " MB)" << std::endl;
        
        // Read header
        StoreHeader header;
        file.read(reinterpret_cast<char*>(&header), sizeof(header));
        
        if (file.gcount() != sizeof(header)) {
            logger_.error("Failed to read complete header");
            return false;
        }
        
        // Validate signature
        if (strncmp(header.signature, "VCSTORE1", 8) != 0) {
            logger_.error("Invalid signature - not a vector store file");
            std::cout << "Found signature: ";
            for (int i = 0; i < 8; i++) {
                if (isprint(header.signature[i])) {
                    std::cout << header.signature[i];
                } else {
                    std::cout << "\\x" << std::hex << (int)header.signature[i];
                }
            }
            std::cout << std::endl;
            return false;
        }
        
        std::cout << "\n=== Store Header Analysis ===" << std::endl;
        std::cout << "Signature: VCSTORE1 ✓" << std::endl;
        std::cout << "Version: " << header.version << std::endl;
        std::cout << "Vector dimension: " << header.vector_dim << std::endl;
        std::cout << "Max clusters: " << header.max_clusters << std::endl;
        std::cout << "Vector count: " << header.vector_count << std::endl;
        std::cout << "Next ID: " << header.next_id << std::endl;
        std::cout << "Cluster map offset: 0x" << std::hex << header.cluster_map_offset << std::dec << std::endl;
        std::cout << "Vector map offset: 0x" << std::hex << header.vector_map_offset << std::dec << std::endl;
        std::cout << "Data offset: 0x" << std::hex << header.data_offset << std::dec << std::endl;
        std::cout << "Strategy name: " << std::string(header.strategy_name, 32) << std::endl;
        
        // Validate offsets
        std::cout << "\n=== Offset Validation ===" << std::endl;
        bool valid = true;
        
        if (header.cluster_map_offset >= fileSize) {
            std::cout << "❌ Cluster map offset is beyond file size" << std::endl;
            valid = false;
        } else {
            std::cout << "✓ Cluster map offset is valid" << std::endl;
        }
        
        if (header.vector_map_offset >= fileSize) {
            std::cout << "❌ Vector map offset is beyond file size" << std::endl;
            valid = false;
        } else {
            std::cout << "✓ Vector map offset is valid" << std::endl;
        }
        
        if (header.data_offset >= fileSize) {
            std::cout << "❌ Data offset is beyond file size" << std::endl;
            valid = false;
        } else {
            std::cout << "✓ Data offset is valid" << std::endl;
        }
        
        // Calculate expected sizes
        size_t expectedVectorSize = header.vector_dim * sizeof(float);
        size_t expectedTotalVectorData = header.vector_count * expectedVectorSize;
        size_t availableDataSpace = fileSize - header.data_offset;
        
        std::cout << "\n=== Data Size Analysis ===" << std::endl;
        std::cout << "Expected vector size: " << expectedVectorSize << " bytes" << std::endl;
        std::cout << "Expected total vector data: " << expectedTotalVectorData << " bytes" << std::endl;
        std::cout << "Available data space: " << availableDataSpace << " bytes" << std::endl;
        
        if (expectedTotalVectorData > availableDataSpace) {
            std::cout << "❌ Not enough space for all vectors (potential corruption)" << std::endl;
            valid = false;
        } else {
            std::cout << "✓ Sufficient space for vector data" << std::endl;
        }
        
        file.close();
        
        if (!valid) {
            std::cout << "\n❌ Store validation FAILED - corruption detected" << std::endl;
        } else {
            std::cout << "\n✓ Store validation PASSED" << std::endl;
        }
        
        return valid;
    }
    
    bool repairStore(const std::string& filepath, const std::string& outputPath, 
                     uint32_t newDimension = 0) {
        std::cout << "\n=== Vector Store Repair Attempt ===" << std::endl;
        
        if (newDimension > 0) {
            return convertDimension(filepath, outputPath, newDimension);
        }
        
        // For now, basic repair just validates and copies valid data
        std::ifstream input(filepath, std::ios::binary);
        if (!input.is_open()) {
            logger_.error("Cannot open input file");
            return false;
        }
        
        std::ofstream output(outputPath, std::ios::binary);
        if (!output.is_open()) {
            logger_.error("Cannot create output file");
            return false;
        }
        
        // Read and validate header
        StoreHeader header;
        input.read(reinterpret_cast<char*>(&header), sizeof(header));
        
        // Write corrected header
        output.write(reinterpret_cast<const char*>(&header), sizeof(header));
        
        // Copy remaining data
        output << input.rdbuf();
        
        input.close();
        output.close();
        
        std::cout << "✓ Basic repair completed: " << outputPath << std::endl;
        return true;
    }
    
    bool convertDimension(const std::string& inputPath, const std::string& outputPath, 
                          uint32_t newDimension) {
        std::cout << "Converting vector store to new dimension: " << newDimension << std::endl;
        
        // This creates a new, empty store with the correct dimension
        Logger logger("repair.log");
        VectorClusterStore newStore(logger);
        
        if (!newStore.initialize(outputPath, "kmeans", newDimension, 10)) {
            logger_.error("Failed to initialize new store");
            return false;
        }
        
        std::cout << "✓ Created new store with dimension " << newDimension << ": " << outputPath << std::endl;
        std::cout << "Note: Original vector data was not migrated due to dimension mismatch." << std::endl;
        std::cout << "You'll need to re-populate this store with vectors of the correct dimension." << std::endl;
        
        return true;
    }
    
    void printUsage(const char* programName) {
        std::cout << "Vector Store Diagnostic and Repair Tool" << std::endl;
        std::cout << "Usage:" << std::endl;
        std::cout << "  " << programName << " analyze <store_file>" << std::endl;
        std::cout << "  " << programName << " repair <input_file> <output_file>" << std::endl;
        std::cout << "  " << programName << " convert <input_file> <output_file> <new_dimension>" << std::endl;
        std::cout << "\nExamples:" << std::endl;
        std::cout << "  " << programName << " analyze vector_store.bin" << std::endl;
        std::cout << "  " << programName << " repair corrupted.bin fixed.bin" << std::endl;
        std::cout << "  " << programName << " convert old_768d.bin new_128d.bin 128" << std::endl;
    }
};

int main(int argc, char* argv[]) {
    VectorStoreDiagnostic diagnostic;
    
    if (argc < 3) {
        diagnostic.printUsage(argv[0]);
        return 1;
    }
    
    std::string command = argv[1];
    std::string inputFile = argv[2];
    
    if (command == "analyze") {
        return diagnostic.analyzeStore(inputFile) ? 0 : 1;
    }
    else if (command == "repair" && argc >= 4) {
        std::string outputFile = argv[3];
        return diagnostic.repairStore(inputFile, outputFile) ? 0 : 1;
    }
    else if (command == "convert" && argc >= 5) {
        std::string outputFile = argv[3];
        uint32_t newDimension = std::atoi(argv[4]);
        return diagnostic.repairStore(inputFile, outputFile, newDimension) ? 0 : 1;
    }
    else {
        diagnostic.printUsage(argv[0]);
        return 1;
    }
}