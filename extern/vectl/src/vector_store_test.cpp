#include "vector_cluster_store.h"
#include "logger.h"
#include <iostream>
#include <random>
#include <chrono>
#include <vector>
#include <string>
#include <iomanip>
#include <algorithm>
#include <numeric>
#include <fstream>
#include <sstream>
#include <memory>
#include <cstring>
#include <thread>
#include <mutex>
#include <csignal>
#include <cstdio>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>

// Constants for testing
constexpr uint32_t DEFAULT_VECTOR_DIM = 128;
constexpr uint32_t DEFAULT_NUM_VECTORS = 1000;
constexpr uint32_t DEFAULT_NUM_QUERIES = 100;
constexpr uint32_t DEFAULT_NUM_CLUSTERS = 10;
constexpr uint32_t DEFAULT_BATCH_SIZE = 100;

// Timer class for measuring performance
class Timer {
public:
    Timer() : start_(std::chrono::high_resolution_clock::now()) {}
    
    double elapsed() {
        auto now = std::chrono::high_resolution_clock::now();
        return std::chrono::duration<double, std::milli>(now - start_).count();
    }
    
    void reset() {
        start_ = std::chrono::high_resolution_clock::now();
    }
    
private:
    std::chrono::time_point<std::chrono::high_resolution_clock> start_;
};

// Structure to hold test results
struct TestResult {
    std::string test_name;
    double duration_ms;
    double ops_per_second;
    size_t num_operations;
    std::string device_path;
    bool direct_io;
    std::string additional_info;
};

// Structure to hold test configuration
struct TestConfig {
    std::string device_path;
    bool use_direct_io;
    uint32_t vector_dim;
    uint32_t num_vectors;
    uint32_t num_queries;
    uint32_t num_clusters;
    uint32_t batch_size;
    bool perform_maintenance;
    bool verbose;
};

// Generate random vectors
std::vector<std::vector<float>> generateRandomVectors(size_t count, size_t dim, unsigned int seed = 42) {
    std::mt19937 gen(seed);
    std::normal_distribution<float> dist(0.0f, 1.0f);
    
    std::vector<std::vector<float>> vectors;
    vectors.reserve(count);
    
    for (size_t i = 0; i < count; i++) {
        std::vector<float> vec(dim);
        for (size_t j = 0; j < dim; j++) {
            vec[j] = dist(gen);
        }
        
        // Normalize vector
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
std::vector<std::pair<std::vector<float>, uint32_t>> generateClusteredVectors(
    size_t count, size_t dim, size_t num_clusters, unsigned int seed = 42) 
{
    std::mt19937 gen(seed);
    std::normal_distribution<float> centroid_dist(0.0f, 10.0f);
    std::normal_distribution<float> offset_dist(0.0f, 0.2f);
    
    // Generate cluster centroids
    std::vector<std::vector<float>> centroids;
    for (size_t i = 0; i < num_clusters; i++) {
        std::vector<float> centroid(dim);
        for (size_t j = 0; j < dim; j++) {
            centroid[j] = centroid_dist(gen);
        }
        centroids.push_back(centroid);
    }
    
    // Generate vectors around centroids
    std::vector<std::pair<std::vector<float>, uint32_t>> vectors;
    
    for (size_t i = 0; i < count; i++) {
        size_t cluster_idx = i % num_clusters; // Distribute evenly
        
        const auto& centroid = centroids[cluster_idx];
        std::vector<float> vec(dim);
        
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

// Test vector write performance
TestResult testWritePerformance(VectorClusterStore& store, 
                              const std::vector<std::vector<float>>& vectors,
                              const TestConfig& config) 
{
    TestResult result;
    result.test_name = "Vector Write";
    result.device_path = config.device_path;
    result.direct_io = config.use_direct_io;
    result.num_operations = vectors.size();
    
    std::cout << "Testing vector write performance..." << std::endl;
    
    Timer timer;
    
    for (size_t i = 0; i < vectors.size(); i++) {
        std::string metadata = "Test vector " + std::to_string(i);
        store.storeVector(i, vectors[i], metadata);
        
        if (config.verbose && (i+1) % config.batch_size == 0) {
            std::cout << "Wrote " << (i+1) << "/" << vectors.size() 
                      << " vectors (" << std::fixed << std::setprecision(2)
                      << (i+1) * 100.0 / vectors.size() << "%)" << std::endl;
        }
    }
    
    result.duration_ms = timer.elapsed();
    result.ops_per_second = (vectors.size() * 1000.0) / result.duration_ms;
    
    std::cout << "Write test completed in " << std::fixed << std::setprecision(2)
              << result.duration_ms << " ms (" << result.ops_per_second 
              << " vectors/second)" << std::endl;
    
    return result;
}

// Test vector read performance
TestResult testReadPerformance(VectorClusterStore& store, size_t num_vectors,
                             const TestConfig& config) 
{
    TestResult result;
    result.test_name = "Vector Read";
    result.device_path = config.device_path;
    result.direct_io = config.use_direct_io;
    result.num_operations = num_vectors;
    
    std::cout << "Testing vector read performance..." << std::endl;
    
    // Prepare vector IDs to read
    std::vector<uint32_t> ids(num_vectors);
    std::iota(ids.begin(), ids.end(), 0); // Fill with 0, 1, 2, ...
    
    // Shuffle IDs to simulate random access
    std::mt19937 g(42);
    std::shuffle(ids.begin(), ids.end(), g);
    
    Timer timer;
    size_t successful_reads = 0;
    
    for (size_t i = 0; i < ids.size(); i++) {
        std::vector<float> vector;
        if (store.retrieveVector(ids[i], vector)) {
            successful_reads++;
        }
        
        if (config.verbose && (i+1) % config.batch_size == 0) {
            std::cout << "Read " << (i+1) << "/" << ids.size() 
                      << " vectors (" << std::fixed << std::setprecision(2)
                      << (i+1) * 100.0 / ids.size() << "%)" << std::endl;
        }
    }
    
    result.duration_ms = timer.elapsed();
    result.ops_per_second = (successful_reads * 1000.0) / result.duration_ms;
    result.additional_info = "Successfully read " + std::to_string(successful_reads) + 
                            " out of " + std::to_string(ids.size()) + " vectors";
    
    std::cout << "Read test completed in " << std::fixed << std::setprecision(2)
              << result.duration_ms << " ms (" << result.ops_per_second 
              << " vectors/second)" << std::endl;
    std::cout << result.additional_info << std::endl;
    
    return result;
}

// Test vector search performance
TestResult testSearchPerformance(VectorClusterStore& store, 
                               const std::vector<std::vector<float>>& queries,
                               const TestConfig& config) 
{
    TestResult result;
    result.test_name = "Vector Search";
    result.device_path = config.device_path;
    result.direct_io = config.use_direct_io;
    result.num_operations = queries.size();
    
    std::cout << "Testing vector search performance..." << std::endl;
    
    Timer timer;
    size_t total_results = 0;
    
    for (size_t i = 0; i < queries.size(); i++) {
        auto results = store.findSimilarVectors(queries[i], 10); // Find top 10 matches
        total_results += results.size();
        
        if (config.verbose && (i+1) % (config.batch_size/10) == 0) {
            std::cout << "Processed " << (i+1) << "/" << queries.size() 
                      << " queries (" << std::fixed << std::setprecision(2)
                      << (i+1) * 100.0 / queries.size() << "%)" << std::endl;
        }
    }
    
    result.duration_ms = timer.elapsed();
    result.ops_per_second = (queries.size() * 1000.0) / result.duration_ms;
    result.additional_info = "Found " + std::to_string(total_results) + 
                            " results for " + std::to_string(queries.size()) + " queries";
    
    std::cout << "Search test completed in " << std::fixed << std::setprecision(2)
              << result.duration_ms << " ms (" << result.ops_per_second 
              << " queries/second)" << std::endl;
    std::cout << result.additional_info << std::endl;
    
    return result;
}

// Test maintenance performance
TestResult testMaintenancePerformance(VectorClusterStore& store,
                                    const TestConfig& config) 
{
    TestResult result;
    result.test_name = "Cluster Maintenance";
    result.device_path = config.device_path;
    result.direct_io = config.use_direct_io;
    result.num_operations = 1;
    
    std::cout << "Testing cluster maintenance performance..." << std::endl;
    
    Timer timer;
    bool success = store.performMaintenance();
    
    result.duration_ms = timer.elapsed();
    result.ops_per_second = 0; // Not applicable for this test
    result.additional_info = success ? "Maintenance successful" : "Maintenance failed";
    
    std::cout << "Maintenance test completed in " << std::fixed << std::setprecision(2)
              << result.duration_ms << " ms" << std::endl;
    std::cout << result.additional_info << std::endl;
    
    return result;
}

// Check if a file exists
bool fileExists(const std::string& path) {
    struct stat buffer;
    return (stat(path.c_str(), &buffer) == 0);
}

// Check if a path is a block device
bool isBlockDevice(const std::string& path) {
    struct stat buffer;
    if (stat(path.c_str(), &buffer) != 0) {
        return false;
    }
    return S_ISBLK(buffer.st_mode);
}

// Create or reset a test file
bool prepareTestFile(const std::string& path, size_t size_mb) {
    // Open/create the file
    int fd = open(path.c_str(), O_RDWR | O_CREAT | O_TRUNC, 0644);
    if (fd < 0) {
        std::cerr << "Failed to create test file: " << strerror(errno) << std::endl;
        return false;
    }
    
    // Allocate space
    size_t file_size = size_mb * 1024 * 1024;
    if (ftruncate(fd, file_size) != 0) {
        std::cerr << "Failed to resize file: " << strerror(errno) << std::endl;
        close(fd);
        return false;
    }
    
    // Fill with zeros in chunks
    const size_t chunk_size = 1024 * 1024; // 1MB
    char* buffer = new char[chunk_size]();
    
    for (size_t i = 0; i < size_mb; i++) {
        if (write(fd, buffer, chunk_size) != chunk_size) {
            std::cerr << "Failed to write to file: " << strerror(errno) << std::endl;
            delete[] buffer;
            close(fd);
            return false;
        }
    }
    
    delete[] buffer;
    fsync(fd);
    close(fd);
    return true;
}

// Run a complete test suite
std::vector<TestResult> runTestSuite(const TestConfig& config) {
    std::vector<TestResult> results;
    
    // Prepare device path
    std::string device_path = config.device_path;
    bool is_block_device = isBlockDevice(device_path);
    
    // If it's a file, make sure it exists and has enough space
    if (!is_block_device) {
        if (!fileExists(device_path)) {
            std::cout << "Creating test file: " << device_path << " (128MB)" << std::endl;
            if (!prepareTestFile(device_path, 128)) { // 128MB
                std::cerr << "Failed to prepare test file!" << std::endl;
                return results;
            }
        }
    }
    
    // Create logger
    Logger logger("vector_store_test.log");
    
    // Generate test data
    std::cout << "Generating " << config.num_vectors << " test vectors with dimension "
              << config.vector_dim << "..." << std::endl;
    auto vectors = generateRandomVectors(config.num_vectors, config.vector_dim, 42);
    
    // Generate query vectors (using a different seed)
    std::cout << "Generating " << config.num_queries << " query vectors..." << std::endl;
    auto query_vectors = generateRandomVectors(config.num_queries, config.vector_dim, 100);
    
    // Initialize store
    std::cout << "Initializing vector store on " << device_path
              << (config.use_direct_io ? " with" : " without") << " direct I/O..." << std::endl;
    VectorClusterStore store(logger);
    
    if (!store.initialize(device_path, "kmeans", config.vector_dim, config.num_clusters)) {
        std::cerr << "Failed to initialize vector store!" << std::endl;
        return results;
    }
    
    // Run write test
    results.push_back(testWritePerformance(store, vectors, config));
    
    // Run read test
    results.push_back(testReadPerformance(store, config.num_vectors, config));
    
    // Run search test
    results.push_back(testSearchPerformance(store, query_vectors, config));
    
    // Optionally run maintenance test
    if (config.perform_maintenance) {
        results.push_back(testMaintenancePerformance(store, config));
    }
    
    return results;
}

// Generate a performance report
void generateReport(const std::vector<TestResult>& standard_results,
                   const std::vector<TestResult>& direct_io_results = {}) 
{
    std::ofstream report("vector_store_performance_report.txt");
    
    if (!report.is_open()) {
        std::cerr << "Failed to create report file!" << std::endl;
        return;
    }
    
    report << "==========================================" << std::endl;
    report << "Vector Store Performance Test Report" << std::endl;
    report << "==========================================" << std::endl;
    report << "Generated on: " << std::time(nullptr) << std::endl;
    report << std::endl;
    
    if (!standard_results.empty()) {
        report << "Device Path: " << standard_results[0].device_path << std::endl;
        report << "Direct I/O: " << (standard_results[0].direct_io ? "Enabled" : "Disabled") << std::endl;
        report << std::endl;
        
        report << "Test Results:" << std::endl;
        report << "--------------------------------------------" << std::endl;
        for (const auto& result : standard_results) {
            report << result.test_name << ":" << std::endl;
            report << "  Duration: " << std::fixed << std::setprecision(2) 
                   << result.duration_ms << " ms" << std::endl;
            report << "  Operations: " << result.num_operations << std::endl;
            report << "  Throughput: " << std::fixed << std::setprecision(2) 
                   << result.ops_per_second << " ops/second" << std::endl;
            if (!result.additional_info.empty()) {
                report << "  Additional Info: " << result.additional_info << std::endl;
            }
            report << std::endl;
        }
    }
    
    if (!direct_io_results.empty()) {
        report << "Direct I/O Results:" << std::endl;
        report << "--------------------------------------------" << std::endl;
        for (const auto& result : direct_io_results) {
            report << result.test_name << ":" << std::endl;
            report << "  Duration: " << std::fixed << std::setprecision(2) 
                   << result.duration_ms << " ms" << std::endl;
            report << "  Operations: " << result.num_operations << std::endl;
            report << "  Throughput: " << std::fixed << std::setprecision(2) 
                   << result.ops_per_second << " ops/second" << std::endl;
            if (!result.additional_info.empty()) {
                report << "  Additional Info: " << result.additional_info << std::endl;
            }
            report << std::endl;
        }
    }
    
    // Comparison (if both sets of results are available)
    if (!standard_results.empty() && !direct_io_results.empty()) {
        report << "Performance Comparison (Direct I/O vs Standard):" << std::endl;
        report << "--------------------------------------------" << std::endl;
        
        for (size_t i = 0; i < std::min(standard_results.size(), direct_io_results.size()); i++) {
            const auto& std_result = standard_results[i];
            const auto& dio_result = direct_io_results[i];
            
            if (std_result.test_name == dio_result.test_name) {
                double speedup = dio_result.ops_per_second / std_result.ops_per_second;
                report << std_result.test_name << ":" << std::endl;
                report << "  Standard Throughput: " << std::fixed << std::setprecision(2) 
                       << std_result.ops_per_second << " ops/second" << std::endl;
                report << "  Direct I/O Throughput: " << std::fixed << std::setprecision(2) 
                       << dio_result.ops_per_second << " ops/second" << std::endl;
                report << "  Speedup Factor: " << std::fixed << std::setprecision(2) 
                       << speedup << "x" << std::endl;
                report << "  Percentage Improvement: " << std::fixed << std::setprecision(2) 
                       << (speedup - 1.0) * 100.0 << "%" << std::endl;
                report << std::endl;
            }
        }
    }
    
    report << "==========================================" << std::endl;
    report.close();
    
    std::cout << "Performance report generated: vector_store_performance_report.txt" << std::endl;
    
    // Also print summary to console
    std::cout << std::endl;
    std::cout << "Performance Summary:" << std::endl;
    std::cout << "--------------------------------------------" << std::endl;
    
    for (const auto& result : standard_results) {
        std::cout << result.test_name << ": " << std::fixed << std::setprecision(2) 
                  << result.ops_per_second << " ops/second" << std::endl;
    }
    
    if (!direct_io_results.empty()) {
        std::cout << std::endl;
        std::cout << "Direct I/O Performance:" << std::endl;
        std::cout << "--------------------------------------------" << std::endl;
        
        for (const auto& result : direct_io_results) {
            std::cout << result.test_name << ": " << std::fixed << std::setprecision(2) 
                      << result.ops_per_second << " ops/second" << std::endl;
        }
    }
}

// Print usage information
void printUsage(const char* program_name) {
    std::cout << "Usage: " << program_name << " [options]" << std::endl;
    std::cout << "Options:" << std::endl;
    std::cout << "  -d, --device PATH       Device or file path (default: ./vector_store.bin)" << std::endl;
    std::cout << "  -b, --block-device      Optional block device for testing" << std::endl;
    std::cout << "  --direct-io             Test with direct I/O" << std::endl;
    std::cout << "  --both                  Test both with and without direct I/O" << std::endl;
    std::cout << "  --dim N                 Vector dimension (default: " << DEFAULT_VECTOR_DIM << ")" << std::endl;
    std::cout << "  --vectors N             Number of vectors to test (default: " << DEFAULT_NUM_VECTORS << ")" << std::endl;
    std::cout << "  --queries N             Number of search queries (default: " << DEFAULT_NUM_QUERIES << ")" << std::endl;
    std::cout << "  --clusters N            Number of clusters (default: " << DEFAULT_NUM_CLUSTERS << ")" << std::endl;
    std::cout << "  --batch-size N          Progress reporting batch size (default: " << DEFAULT_BATCH_SIZE << ")" << std::endl;
    std::cout << "  --maintenance           Perform maintenance test" << std::endl;
    std::cout << "  -v, --verbose           Verbose output" << std::endl;
    std::cout << "  -h, --help              Show this help message" << std::endl;
    std::cout << std::endl;
    std::cout << "Examples:" << std::endl;
    std::cout << "  " << program_name << "                           # Run with default settings" << std::endl;
    std::cout << "  " << program_name << " --both                   # Test with and without direct I/O" << std::endl;
    std::cout << "  " << program_name << " -d /dev/sdb --direct-io  # Test block device with direct I/O" << std::endl;
    std::cout << "  " << program_name << " --dim 768 --vectors 1000 # Test with 768-dim vectors" << std::endl;
}

int main(int argc, char** argv) {
    // Default configuration
    TestConfig config;
    config.device_path = "./vector_store.bin";
    config.use_direct_io = false;
    config.vector_dim = DEFAULT_VECTOR_DIM;
    config.num_vectors = DEFAULT_NUM_VECTORS;
    config.num_queries = DEFAULT_NUM_QUERIES;
    config.num_clusters = DEFAULT_NUM_CLUSTERS;
    config.batch_size = DEFAULT_BATCH_SIZE;
    config.perform_maintenance = false;
    config.verbose = false;
    
    bool test_both = false;
    std::string block_device = "";
    
    // Parse command line arguments
    for (int i = 1; i < argc; i++) {
        std::string arg = argv[i];
        
        if (arg == "-h" || arg == "--help") {
            printUsage(argv[0]);
            return 0;
        } else if (arg == "-d" || arg == "--device") {
            if (i + 1 < argc) {
                config.device_path = argv[++i];
            }
        } else if (arg == "-b" || arg == "--block-device") {
            if (i + 1 < argc) {
                block_device = argv[++i];
            }
        } else if (arg == "--direct-io") {
            config.use_direct_io = true;
        } else if (arg == "--both") {
            test_both = true;
        } else if (arg == "--dim") {
            if (i + 1 < argc) {
                config.vector_dim = std::stoi(argv[++i]);
            }
        } else if (arg == "--vectors") {
            if (i + 1 < argc) {
                config.num_vectors = std::stoi(argv[++i]);
            }
        } else if (arg == "--queries") {
            if (i + 1 < argc) {
                config.num_queries = std::stoi(argv[++i]);
            }
        } else if (arg == "--clusters") {
            if (i + 1 < argc) {
                config.num_clusters = std::stoi(argv[++i]);
            }
        } else if (arg == "--batch-size") {
            if (i + 1 < argc) {
                config.batch_size = std::stoi(argv[++i]);
            }
        } else if (arg == "--maintenance") {
            config.perform_maintenance = true;
        } else if (arg == "-v" || arg == "--verbose") {
            config.verbose = true;
        }
    }
    
    // Print test configuration
    std::cout << "Vector Store Performance Test" << std::endl;
    std::cout << "============================" << std::endl;
    std::cout << "Device Path: " << config.device_path << std::endl;
    std::cout << "Direct I/O: " << (config.use_direct_io ? "Enabled" : "Disabled") << std::endl;
    std::cout << "Vector Dimension: " << config.vector_dim << std::endl;
    std::cout << "Test Vectors: " << config.num_vectors << std::endl;
    std::cout << "Search Queries: " << config.num_queries << std::endl;
    std::cout << "Number of Clusters: " << config.num_clusters << std::endl;
    std::cout << "Maintenance Test: " << (config.perform_maintenance ? "Enabled" : "Disabled") << std::endl;
    std::cout << "Test Both I/O Modes: " << (test_both ? "Yes" : "No") << std::endl;
    if (!block_device.empty()) {
        std::cout << "Block Device: " << block_device << std::endl;
    }
    std::cout << "============================" << std::endl;
    std::cout << std::endl;
    
    // Results containers
    std::vector<TestResult> standard_results;
    std::vector<TestResult> direct_io_results;
    
    // Run standard I/O test if needed
    if (!config.use_direct_io || test_both) {
        TestConfig std_config = config;
        std_config.use_direct_io = false;
        
        std::cout << "Running standard.." << std::endl;
        standard_results = runTestSuite(std_config);
    }
    
    // Run direct I/O test if needed
    if (config.use_direct_io || test_both) {
        TestConfig dio_config = config;
        dio_config.use_direct_io = true;
        
        std::cout << std::endl;
        std::cout << "Running direct I/O tests..." << std::endl;
        direct_io_results = runTestSuite(dio_config);
    }
    
    // Generate report
    generateReport(standard_results, direct_io_results);
    
    // Run block device test if specified
    if (!block_device.empty()) {
        std::cout << std::endl;
        std::cout << "Running tests on block device: " << block_device << std::endl;
        
        if (isBlockDevice(block_device)) {
            TestConfig block_config = config;
            block_config.device_path = block_device;
            
            // Run without direct I/O
            std::cout << "Running standard I/O tests on block device..." << std::endl;
            block_config.use_direct_io = false;
            auto block_standard_results = runTestSuite(block_config);
            
            // Run with direct I/O
            std::cout << std::endl;
            std::cout << "Running direct I/O tests on block device..." << std::endl;
            block_config.use_direct_io = true;
            auto block_dio_results = runTestSuite(block_config);
            
            // Generate block device report
            std::string report_name = "block_device_performance_report.txt";
            std::ofstream report(report_name);
            
            if (report.is_open()) {
                report << "=======================================" << std::endl;
                report << "Block Device Performance Test Report" << std::endl;
                report << "=======================================" << std::endl;
                report << "Device: " << block_device << std::endl;
                report << std::endl;
                
                // Add standard IO results
                report << "Standard I/O Results:" << std::endl;
                report << "--------------------------------------------" << std::endl;
                for (const auto& result : block_standard_results) {
                    report << result.test_name << ":" << std::endl;
                    report << "  Duration: " << std::fixed << std::setprecision(2) 
                           << result.duration_ms << " ms" << std::endl;
                    report << "  Throughput: " << std::fixed << std::setprecision(2) 
                           << result.ops_per_second << " ops/second" << std::endl;
                    report << std::endl;
                }
                
                // Add direct IO results
                report << "Direct I/O Results:" << std::endl;
                report << "--------------------------------------------" << std::endl;
                for (const auto& result : block_dio_results) {
                    report << result.test_name << ":" << std::endl;
                    report << "  Duration: " << std::fixed << std::setprecision(2) 
                           << result.duration_ms << " ms" << std::endl;
                    report << "  Throughput: " << std::fixed << std::setprecision(2) 
                           << result.ops_per_second << " ops/second" << std::endl;
                    report << std::endl;
                }
                
                // Add comparison
                report << "Performance Comparison (Direct I/O vs Standard):" << std::endl;
                report << "-----------------------------------------" << std::endl;
                
                for (size_t i = 0; i < std::min(block_standard_results.size(), block_dio_results.size()); i++) {
                    const auto& std_result = block_standard_results[i];
                    const auto& dio_result = block_dio_results[i];
                    
                    if (std_result.test_name == dio_result.test_name) {
                        double speedup = dio_result.ops_per_second / std_result.ops_per_second;
                        report << std_result.test_name << ":" << std::endl;
                        report << "  Standard Throughput: " << std::fixed << std::setprecision(2) 
                               << std_result.ops_per_second << " ops/second" << std::endl;
                        report << "  Direct I/O Throughput: " << std::fixed << std::setprecision(2) 
                               << dio_result.ops_per_second << " ops/second" << std::endl;
                        report << "  Speedup Factor: " << std::fixed << std::setprecision(2) 
                               << speedup << "x" << std::endl;
                        report << std::endl;
                    }
                }
                
                report.close();
                std::cout << "Block device performance report generated: " << report_name << std::endl;
            }
        } else {
            std::cerr << "Error: " << block_device << " is not a block device!" << std::endl;
        }
    }
    
    std::cout << "All tests completed!" << std::endl;
    return 0;
}
