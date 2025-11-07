#include "vector_cluster_store.h"
#include <fcntl.h>
#include <unistd.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <linux/fs.h>
#include <cstring>
#include <iostream>
#include <algorithm>
#include <cmath>
#include <fstream>

// Assuming Logger class is defined in a separate header
// extern class Logger;

VectorClusterStore::VectorClusterStore(Logger& logger)
    : fd_(-1), device_size_(0), block_size_(0), is_direct_io_(false),
      vector_dim_(0), next_vector_id_(0), header_offset_(0),
      cluster_map_offset_(0), vector_map_offset_(0), data_offset_(0),
      logger_(logger) {
}

VectorClusterStore::~VectorClusterStore() {
    closeDevice();
}

bool VectorClusterStore::initialize(const std::string& device_path, 
                                   const std::string& strategy_name,
                                   uint32_t vector_dim,
                                   uint32_t max_clusters) {
    std::lock_guard<std::mutex> lock(store_mutex_);
    
    // Set device path and parameters
    device_path_ = device_path;
    vector_dim_ = vector_dim;
    
    // Create clustering strategy
    clustering_ = createClusteringStrategy(strategy_name, logger_);
    if (!clustering_) {
        logger_.error("Failed to create clustering strategy: " + strategy_name);
        return false;
    }
    
    // Initialize clustering strategy
    if (!clustering_->initialize(vector_dim, max_clusters)) {
        logger_.error("Failed to initialize clustering strategy");
        return false;
    }
    
    // Open device
    if (!openDevice()) {
        return false;
    }

    // Define layout
    header_offset_ = 0;  // Store header at the beginning
    cluster_map_offset_ = 512;  // After header
    // Increase to 50MB for cluster map (5x more space than before)
    vector_map_offset_ = cluster_map_offset_ + (50 * 1024 * 1024);
    data_offset_ = vector_map_offset_ + (10 * 1024 * 1024);  // Still 10MB for vector map
    
    // Define layout
    //header_offset_ = 0;  // Store header at the beginning
    //cluster_map_offset_ = 512;  // After header
    //vector_map_offset_ = cluster_map_offset_ + (max_clusters * 512);  // After cluster map
    //data_offset_ = vector_map_offset_ + (1024 * 1024);  // Leave 1MB for vector map
    
    // Check if the device has a valid header
    if (readHeader()) {
        logger_.info("Found existing vector store, loading data");
        
        // Read cluster map and vector map
        if (!readClusterMap() || !readVectorMap()) {
            logger_.error("Failed to read store metadata");
            closeDevice();
            return false;
        }
    } else {
        logger_.info("Initializing new vector store");
        
        // Initialize new store
        next_vector_id_ = 0;
        vector_map_.clear();
        
        // Write header
        if (!writeHeader()) {
            logger_.error("Failed to write store header");
            closeDevice();
            return false;
        }
        
        // Write empty maps
        if (!writeClusterMap() || !writeVectorMap()) {
            logger_.error("Failed to write store metadata");
            closeDevice();
            return false;
        }
    }
    
    logger_.info("Vector store initialized successfully");
    return true;
}

bool VectorClusterStore::openDevice(bool readOnly) {
    if (device_path_.empty()) {
        logger_.error("No device path specified");
        return false;
    }
    
    if (fd_ >= 0) {
        closeDevice();
    }
    
    int flags = readOnly ? O_RDONLY : O_RDWR;
    
    // Add O_CREAT flag if this might be a new file
    if (!readOnly && device_path_[0] != '/') {
        flags |= O_CREAT;
    }
    
    logger_.debug("Opening device/file: " + device_path_);
    fd_ = open(device_path_.c_str(), flags, 0644);  // Add permissions for creation
    
    if (fd_ < 0) {
        logger_.error("Failed to open device/file: " + device_path_ + ", error: " + strerror(errno));
        return false;
    }
    
    // Check if it's a block device or regular file
    struct stat st;
    if (fstat(fd_, &st) < 0) {
        logger_.error("Failed to stat file: " + std::string(strerror(errno)));
        closeDevice();
        return false;
    }
    
    bool is_block_device = S_ISBLK(st.st_mode);
    logger_.debug(device_path_ + " is a " + (is_block_device ? "block device" : "regular file"));
    
    if (is_block_device) {
        // For block devices, use ioctl to get size and block size
        if (ioctl(fd_, BLKGETSIZE64, &device_size_) < 0) {
            logger_.error("Failed to get device size: " + std::string(strerror(errno)));
            closeDevice();
            return false;
        }
        
        if (ioctl(fd_, BLKSSZGET, &block_size_) < 0) {
            logger_.error("Failed to get block size: " + std::string(strerror(errno)));
            closeDevice();
            return false;
        }
    } else {
        // For regular files, use fstat for size and use default block size
        device_size_ = st.st_size;
        block_size_ = 512;  // Default block size for files
        
        // If file is empty or new, set a minimum size
        if (device_size_ == 0 && !readOnly) {
            // Initialize with 100MB for new files
            const off_t min_size = 100 * 1024 * 1024;
            logger_.info("Initializing new file with size " + std::to_string(min_size) + " bytes");
            
            if (ftruncate(fd_, min_size) < 0) {
                logger_.error("Failed to initialize file size: " + std::string(strerror(errno)));
                closeDevice();
                return false;
            }
            device_size_ = min_size;
        }
    }
    
    is_direct_io_ = false;
    
    logger_.info("Device/file opened successfully");
    logger_.info("Size: " + std::to_string(device_size_) + " bytes");
    logger_.info("Block size: " + std::to_string(block_size_) + " bytes");
    
    return true;
}

bool VectorClusterStore::openDeviceWithDirectIO(bool readOnly) {
    if (device_path_.empty()) {
        logger_.error("No device path specified");
        return false;
    }
    
    if (fd_ >= 0) {
        closeDevice();
    }
    
    int flags = readOnly ? O_RDONLY : O_RDWR;
    flags |= O_DIRECT;
    
    logger_.debug("Opening device/file with O_DIRECT: " + device_path_);
    fd_ = open(device_path_.c_str(), flags);
    
    if (fd_ < 0) {
        logger_.error("Failed to open with O_DIRECT: " + device_path_ + 
                    ", error: " + strerror(errno) + 
                    ". Falling back to standard I/O.");
        
        // Fall back to standard I/O
        return openDevice(readOnly);
    }
    
    // Check if it's a block device or regular file
    struct stat st;
    if (fstat(fd_, &st) < 0) {
        logger_.error("Failed to stat file: " + std::string(strerror(errno)));
        closeDevice();
        return false;
    }
    
    bool is_block_device = S_ISBLK(st.st_mode);
    
    if (is_block_device) {
        // For block devices, use ioctl to get size and block size
        if (ioctl(fd_, BLKGETSIZE64, &device_size_) < 0) {
            logger_.error("Failed to get device size: " + std::string(strerror(errno)));
            closeDevice();
            return false;
        }
        
        if (ioctl(fd_, BLKSSZGET, &block_size_) < 0) {
            logger_.error("Failed to get block size: " + std::string(strerror(errno)));
            closeDevice();
            return false;
        }
    } else {
        // For regular files, use fstat for size and use default block size
        device_size_ = st.st_size;
        block_size_ = 512;  // Direct I/O usually requires 512-byte alignment
        
        // If file is empty or new, set a minimum size
        if (device_size_ == 0 && !readOnly) {
            // Initialize with 100MB for new files
            const off_t min_size = 100 * 1024 * 1024;
            logger_.info("Initializing new file with size " + std::to_string(min_size) + " bytes");
            
            if (ftruncate(fd_, min_size) < 0) {
                logger_.error("Failed to initialize file size: " + std::string(strerror(errno)));
                closeDevice();
                return false;
            }
            device_size_ = min_size;
        }
    }
    
    is_direct_io_ = true;
    
    logger_.info("Device/file opened successfully with O_DIRECT");
    logger_.info("Size: " + std::to_string(device_size_) + " bytes");
    logger_.info("Block size: " + std::to_string(block_size_) + " bytes");
    
    return true;
}

void VectorClusterStore::closeDevice() {
    if (fd_ >= 0) {
        close(fd_);
        fd_ = -1;
        logger_.debug("Device closed");
    }
}

bool VectorClusterStore::storeVector(uint32_t vector_id, const Vector& vector, const std::string& metadata) {
    std::lock_guard<std::mutex> lock(store_mutex_);
    
    if (fd_ < 0) {
        logger_.error("Device not open");
        return false;
    }
    
    if (vector.size() != vector_dim_) {
        logger_.error("Vector dimension mismatch: got " + std::to_string(vector.size()) + 
                    ", expected " + std::to_string(vector_dim_));
        return false;
    }
    
    // Assign to a cluster
    uint32_t cluster_id = clustering_->assignToCluster(vector);
    
    // Allocate space for the vector
    uint64_t offset = allocateVectorSpace(cluster_id);
    if (offset == 0) {
        logger_.error("Failed to allocate space for vector");
        return false;
    }
    
    // Write vector to storage
    if (!writeVector(offset, vector)) {
        logger_.error("Failed to write vector data");
        return false;
    }
    
    // Add to vector map
    VectorEntry entry;
    entry.vector_id = vector_id;
    entry.cluster_id = cluster_id;
    entry.offset = offset;
    entry.metadata = metadata;
    
    vector_map_[vector_id] = entry;
    
    // Update clustering model
    clustering_->addVector(vector, vector_id);
    
    // Update next vector ID if needed
    if (vector_id >= next_vector_id_) {
        next_vector_id_ = vector_id + 1;
    }
    
    // Update metadata
    if (!writeHeader() || !writeVectorMap()) {
        logger_.error("Failed to update metadata");
        return false;
    }
    
    logger_.debug("Stored vector " + std::to_string(vector_id) + 
                 " in cluster " + std::to_string(cluster_id));
    
    return true;
}

bool VectorClusterStore::retrieveVector(uint32_t vector_id, Vector& vector) {
    std::lock_guard<std::mutex> lock(store_mutex_);
    
    if (fd_ < 0) {
        logger_.error("Device not open");
        return false;
    }
    
    // Check if vector exists
    auto it = vector_map_.find(vector_id);
    if (it == vector_map_.end()) {
        logger_.error("Vector " + std::to_string(vector_id) + " not found");
        return false;
    }
    
    // Get vector offset
    uint64_t offset = it->second.offset;
    
    // Read vector from storage
    vector.resize(vector_dim_);
    if (!readVector(offset, vector)) {
        logger_.error("Failed to read vector data");
        return false;
    }
    
    logger_.debug("Retrieved vector " + std::to_string(vector_id));
    
    return true;
}

std::string VectorClusterStore::getVectorMetadata(uint32_t vector_id) {
    std::lock_guard<std::mutex> lock(store_mutex_);
    
    if (fd_ < 0) {
        logger_.error("Device not open");
        return "";
    }
    
    // Check if vector exists
    auto it = vector_map_.find(vector_id);
    if (it == vector_map_.end()) {
        logger_.debug("Vector " + std::to_string(vector_id) + " not found");
        return "";
    }
    
    return it->second.metadata;
}

std::vector<std::pair<uint32_t, float>> VectorClusterStore::findSimilarVectors(
    const Vector& query, uint32_t k) {
    
    std::lock_guard<std::mutex> lock(store_mutex_);
    
    if (fd_ < 0) {
        logger_.error("Device not open");
        return {};
    }
    
    if (query.size() != vector_dim_) {
        logger_.error("Query vector dimension mismatch: got " + std::to_string(query.size()) + 
                    ", expected " + std::to_string(vector_dim_));
        return {};
    }
    
    // Find closest clusters
    std::vector<uint32_t> candidate_clusters = clustering_->findClosestClusters(query, 3);
    
    // Process vectors from those clusters
    std::vector<std::pair<uint32_t, float>> candidates;
    std::vector<uint32_t> processed_vectors;
    
    for (uint32_t cluster_id : candidate_clusters) {
        logger_.debug("Searching in cluster " + std::to_string(cluster_id));
        
        // Find vectors in this cluster
        for (const auto& [vector_id, entry] : vector_map_) {
            if (entry.cluster_id == cluster_id) {
                // Get vector data
                Vector vector(vector_dim_);
                if (readVector(entry.offset, vector)) {
                    // Calculate similarity
                    float similarity = calculateCosineSimilarity(query, vector);
                    candidates.push_back({vector_id, similarity});
                    processed_vectors.push_back(vector_id);
                }
            }
        }
    }
    
    logger_.info("Processed " + std::to_string(processed_vectors.size()) + 
                " vectors from " + std::to_string(candidate_clusters.size()) + " clusters");
    
    // Sort by similarity (highest first)
    std::sort(candidates.begin(), candidates.end(), 
              [](const auto& a, const auto& b) { return a.second > b.second; });
    
    // Return top k
    if (candidates.size() > k) {
        candidates.resize(k);
    }
    
    return candidates;
}

bool VectorClusterStore::deleteVector(uint32_t vector_id) {
    std::lock_guard<std::mutex> lock(store_mutex_);
    
    if (fd_ < 0) {
        logger_.error("Device not open");
        return false;
    }
    
    // Check if vector exists
    auto it = vector_map_.find(vector_id);
    if (it == vector_map_.end()) {
        logger_.error("Vector " + std::to_string(vector_id) + " not found");
        return false;
    }
    
    // Get vector data to remove from clustering model
    Vector vector(vector_dim_);
    if (!readVector(it->second.offset, vector)) {
        logger_.error("Failed to read vector data for deletion");
        return false;
    }
    
    // Remove from clustering model
    clustering_->removeVector(vector_id);
    
    // Remove from vector map
    vector_map_.erase(it);
    
    // Update metadata
    if (!writeHeader() || !writeVectorMap()) {
        logger_.error("Failed to update metadata after deletion");
        return false;
    }
    
    logger_.debug("Deleted vector " + std::to_string(vector_id));
    
    // Note: We don't reclaim space on the device yet - this would be a future enhancement
    
    return true;
}

bool VectorClusterStore::performMaintenance() {
    std::lock_guard<std::mutex> lock(store_mutex_);
    
    logger_.info("Performing maintenance");
    
    // Rebalance clusters
    if (clustering_->rebalance()) {
        logger_.info("Clusters rebalanced");
        
        // Update cluster assignments
        for (auto& [vector_id, entry] : vector_map_) {
            // Get vector data
            Vector vector(vector_dim_);
            if (readVector(entry.offset, vector)) {
                // Get new cluster assignment
                uint32_t new_cluster = clustering_->assignToCluster(vector);
                
                if (new_cluster != entry.cluster_id) {
                    logger_.debug("Moving vector " + std::to_string(vector_id) + 
                                 " from cluster " + std::to_string(entry.cluster_id) + 
                                 " to " + std::to_string(new_cluster));
                    
                    // Allocate space in new cluster
                    uint64_t new_offset = allocateVectorSpace(new_cluster);
                    if (new_offset == 0) {
                        logger_.error("Failed to allocate space for vector during rebalancing");
                        continue;
                    }
                    
                    // Write vector to new location
                    if (writeVector(new_offset, vector)) {
                        // Update entry
                        entry.cluster_id = new_cluster;
                        entry.offset = new_offset;
                    }
                }
            }
        }
        
        // Update metadata
        if (!writeVectorMap() || !writeClusterMap()) {
            logger_.error("Failed to update metadata after rebalancing");
            return false;
        }
    }
    
    // Update cluster map to reflect current state
    if (!writeClusterMap()) {
        logger_.error("Failed to update cluster map");
        return false;
    }
    
    logger_.info("Maintenance completed");
    return true;
}

bool VectorClusterStore::saveIndex(const std::string& filename) {
    std::lock_guard<std::mutex> lock(store_mutex_);
    
    // Save clustering model
    if (!clustering_->saveToFile(filename)) {
        logger_.error("Failed to save clustering model");
        return false;
    }
    
    // Save vector map to a separate file
    std::string vector_map_file = filename + ".vmap";
    std::ofstream file(vector_map_file, std::ios::binary);
    if (!file.is_open()) {
        logger_.error("Failed to open vector map file for writing");
        return false;
    }
    
    // Write number of vectors
    uint32_t num_vectors = static_cast<uint32_t>(vector_map_.size());
    file.write(reinterpret_cast<const char*>(&num_vectors), sizeof(uint32_t));
    
    // Write vector entries
    for (const auto& [vector_id, entry] : vector_map_) {
        file.write(reinterpret_cast<const char*>(&vector_id), sizeof(uint32_t));
        file.write(reinterpret_cast<const char*>(&entry.cluster_id), sizeof(uint32_t));
        file.write(reinterpret_cast<const char*>(&entry.offset), sizeof(uint64_t));
        
        // Write metadata string
        uint32_t metadata_size = static_cast<uint32_t>(entry.metadata.size());
        file.write(reinterpret_cast<const char*>(&metadata_size), sizeof(uint32_t));
        file.write(entry.metadata.c_str(), metadata_size);
    }
    
    bool success = !file.bad();
    file.close();
    
    if (success) {
        logger_.info("Index saved to " + filename);
    } else {
        logger_.error("Failed to save vector map");
    }
    
    return success;
}

bool VectorClusterStore::loadIndex(const std::string& filename) {
    std::lock_guard<std::mutex> lock(store_mutex_);
    
    // Load clustering model
    if (!clustering_->loadFromFile(filename)) {
        logger_.error("Failed to load clustering model");
        return false;
    }
    
    // Load vector map from a separate file
    std::string vector_map_file = filename + ".vmap";
    std::ifstream file(vector_map_file, std::ios::binary);
    if (!file.is_open()) {
        logger_.error("Failed to open vector map file for reading");
        return false;
    }
    
    // Clear existing vector map
    vector_map_.clear();
    
    // Read number of vectors
    uint32_t num_vectors;
    file.read(reinterpret_cast<char*>(&num_vectors), sizeof(uint32_t));
    
    // Read vector entries
    for (uint32_t i = 0; i < num_vectors; i++) {
        uint32_t vector_id;
        VectorEntry entry;
        
        file.read(reinterpret_cast<char*>(&vector_id), sizeof(uint32_t));
        file.read(reinterpret_cast<char*>(&entry.vector_id), sizeof(uint32_t));
	file.read(reinterpret_cast<char*>(&entry.cluster_id), sizeof(uint32_t));
        file.read(reinterpret_cast<char*>(&entry.offset), sizeof(uint64_t));
        
        // Read metadata string
        uint32_t metadata_size;
        file.read(reinterpret_cast<char*>(&metadata_size), sizeof(uint32_t));
        
        if (metadata_size > 0) {
            std::vector<char> metadata_buffer(metadata_size);
            file.read(metadata_buffer.data(), metadata_size);
            entry.metadata.assign(metadata_buffer.data(), metadata_size);
        }
        
        vector_map_[vector_id] = entry;
        
        // Update next_vector_id if needed
        if (vector_id >= next_vector_id_) {
            next_vector_id_ = vector_id + 1;
        }
    }
    
    bool success = !file.bad() && !file.fail();
    file.close();
    
    if (success) {
        logger_.info("Index loaded from " + filename);
        logger_.info("Loaded " + std::to_string(vector_map_.size()) + " vectors");
        
        // Update device metadata
        if (!writeHeader() || !writeVectorMap() || !writeClusterMap()) {
            logger_.error("Failed to update device metadata after loading index");
            return false;
        }
    } else {
        logger_.error("Failed to load vector map");
    }
    
    return success;
}

void VectorClusterStore::printStoreInfo() const {
    if (fd_ < 0) {
        std::cout << "Device not open" << std::endl;
        return;
    }
    
    std::cout << "=== Vector Cluster Store Information ===" << std::endl;
    std::cout << "Device path: " << device_path_ << std::endl;
    std::cout << "Device size: " << device_size_ << " bytes (" 
              << (device_size_ / (1024*1024)) << " MB)" << std::endl;
    std::cout << "Block size: " << block_size_ << " bytes" << std::endl;
    std::cout << "Direct I/O: " << (is_direct_io_ ? "Yes" : "No") << std::endl;
    std::cout << "Vector dimension: " << vector_dim_ << std::endl;
    std::cout << "Vector count: " << vector_map_.size() << std::endl;
    std::cout << "Next vector ID: " << next_vector_id_ << std::endl;
    std::cout << "Clustering strategy: " << clustering_->getName() << std::endl;
    
    // Get cluster counts
    std::unordered_map<uint32_t, uint32_t> cluster_counts;
    for (const auto& [_, entry] : vector_map_) {
        cluster_counts[entry.cluster_id]++;
    }
    
    std::cout << "Cluster distribution:" << std::endl;
    for (const auto& [cluster_id, count] : cluster_counts) {
        std::cout << "  Cluster " << cluster_id << ": " << count << " vectors" << std::endl;
    }
    
    std::cout << "=================================" << std::endl;
}

void VectorClusterStore::printClusterInfo(uint32_t cluster_id) const {
    if (fd_ < 0) {
        std::cout << "Device not open" << std::endl;
        return;
    }
    
    std::cout << "=== Cluster " << cluster_id << " Information ===" << std::endl;
    
    Vector centroid = clustering_->getClusterCentroid(cluster_id);
    uint32_t size = clustering_->getClusterSize(cluster_id);
    
    std::cout << "Size: " << size << " vectors" << std::endl;
    std::cout << "Centroid: [";
    for (size_t i = 0; i < std::min(5ul, centroid.size()); i++) {
        std::cout << centroid[i];
        if (i < std::min(4ul, centroid.size() - 1)) {
            std::cout << ", ";
        }
    }
    if (centroid.size() > 5) {
        std::cout << ", ...";
    }
    std::cout << "]" << std::endl;
    
    // List vectors in this cluster
    std::cout << "Vectors:" << std::endl;
    int count = 0;
    for (const auto& [vector_id, entry] : vector_map_) {
        if (entry.cluster_id == cluster_id) {
            std::cout << "  ID " << vector_id << " at offset " << entry.offset;
            if (!entry.metadata.empty()) {
                std::cout << " (" << entry.metadata << ")";
            }
            std::cout << std::endl;
            count++;
            if (count >= 10) {
                std::cout << "  ... and " << (size - 10) << " more" << std::endl;
                break;
            }
        }
    }
    
    std::cout << "=================================" << std::endl;
}

bool VectorClusterStore::readHeader() {
    if (fd_ < 0) {
        return false;
    }
    
    StoreHeader header;
    if (!readAligned(&header, sizeof(header), header_offset_)) {
        return false;
    }
    
    // Check signature
    if (memcmp(header.signature, STORE_SIGNATURE, sizeof(STORE_SIGNATURE)) != 0) {
        logger_.debug("Invalid store signature");
        return false;
    }
    
    // Check version
    if (header.version != 1) {
        logger_.error("Unsupported store version: " + std::to_string(header.version));
        return false;
    }
    
    // Update store parameters
    vector_dim_ = header.vector_dim;
    next_vector_id_ = header.next_id;
    cluster_map_offset_ = header.cluster_map_offset;
    vector_map_offset_ = header.vector_map_offset;
    data_offset_ = header.data_offset;
    
    logger_.info("Read store header: vector_dim=" + std::to_string(vector_dim_) + 
                ", vector_count=" + std::to_string(header.vector_count));
    
    return true;
}

bool VectorClusterStore::writeHeader() {
    if (fd_ < 0) {
        return false;
    }
    
    StoreHeader header;
    memcpy(header.signature, STORE_SIGNATURE, sizeof(STORE_SIGNATURE));
    header.version = 1;
    header.vector_dim = vector_dim_;
    header.max_clusters = 100;  // Fixed for now
    header.vector_count = static_cast<uint32_t>(vector_map_.size());
    header.next_id = next_vector_id_;
    header.cluster_map_offset = cluster_map_offset_;
    header.vector_map_offset = vector_map_offset_;
    header.data_offset = data_offset_;
    
    std::string strategy_name = clustering_->getName();
    strncpy(header.strategy_name, strategy_name.c_str(), sizeof(header.strategy_name) - 1);
    header.strategy_name[sizeof(header.strategy_name) - 1] = '\0';
    
    memset(header.reserved, 0, sizeof(header.reserved));
    
    return writeAligned(&header, sizeof(header), header_offset_);
}

bool VectorClusterStore::writeClusterMap() {
    if (fd_ < 0) {
        return false;
    }
    
    // Get all clusters
    std::vector<ClusterInfo> clusters = clustering_->getAllClusters();
    
    // Calculate size needed
    size_t size_needed = 0;
    for (const auto& cluster : clusters) {
        size_needed += cluster.serialize().size() + sizeof(uint32_t);
    }
    
    // Ensure we have enough space
    if (size_needed > (vector_map_offset_ - cluster_map_offset_)) {
        logger_.error("Cluster map too large");
        return false;
    }
    
    // Write number of clusters
    uint32_t num_clusters = static_cast<uint32_t>(clusters.size());
    if (!writeAligned(&num_clusters, sizeof(num_clusters), cluster_map_offset_)) {
        return false;
    }
    
    // Write each cluster
    uint64_t offset = cluster_map_offset_ + sizeof(uint32_t);
    for (const auto& cluster : clusters) {
        // Serialize cluster info
        std::vector<uint8_t> serialized = cluster.serialize();
        
        // Write size and data
        uint32_t chunk_size = static_cast<uint32_t>(serialized.size());
        if (!writeAligned(&chunk_size, sizeof(chunk_size), offset)) {
            return false;
        }
        offset += sizeof(chunk_size);
        
        if (!writeAligned(serialized.data(), serialized.size(), offset)) {
            return false;
        }
        offset += serialized.size();
    }
    
    logger_.debug("Wrote cluster map: " + std::to_string(num_clusters) + " clusters");
    return true;
}

bool VectorClusterStore::readClusterMap() {
    if (fd_ < 0) {
        return false;
    }
    
    // Read number of clusters
    uint32_t num_clusters;
    if (!readAligned(&num_clusters, sizeof(num_clusters), cluster_map_offset_)) {
        return false;
    }
    
    // Read each cluster
    uint64_t offset = cluster_map_offset_ + sizeof(uint32_t);
    std::vector<ClusterInfo> clusters;
    
    for (uint32_t i = 0; i < num_clusters; i++) {
        // Read size
        uint32_t chunk_size;
        if (!readAligned(&chunk_size, sizeof(chunk_size), offset)) {
            return false;
        }
        offset += sizeof(chunk_size);
        
        // Read data
        std::vector<uint8_t> serialized(chunk_size);
        if (!readAligned(serialized.data(), chunk_size, offset)) {
            return false;
        }
        offset += chunk_size;
        
        // Deserialize
        ClusterInfo cluster = ClusterInfo::deserialize(serialized);
        clusters.push_back(cluster);
    }
    
    // Update clustering model
    for (const auto& cluster : clusters) {
	(void)cluster;
        // Set cluster location in model
        // (This is simplified - in a real implementation, we would update the model properly)
        // clustering_->setClusterInfo(cluster);
    }
    
    logger_.debug("Read cluster map: " + std::to_string(num_clusters) + " clusters");
    return true;
}
bool VectorClusterStore::writeVectorMap() {
    if (fd_ < 0) {
        return false;
    }
    
    // Calculate size needed
    size_t fixed_entry_size = sizeof(uint32_t) + sizeof(uint32_t) + sizeof(uint64_t) + sizeof(uint32_t);
    size_t size_needed = sizeof(uint32_t);  // Number of vectors
    
    // Sanity check the number of vectors
    const uint32_t MAX_VECTORS = 1000000; // 1 million vectors max
    if (vector_map_.size() > MAX_VECTORS) {
        logger_.error("Vector count too large: " + std::to_string(vector_map_.size()) + 
                     ", maximum allowed: " + std::to_string(MAX_VECTORS));
        return false;
    }
    
    for (const auto& pair : vector_map_) {
        const auto& entry = pair.second;
        // Sanity check metadata size
        const uint32_t MAX_METADATA_SIZE = 10240; // 10KB max per vector
        if (entry.metadata.size() > MAX_METADATA_SIZE) {
            logger_.error("Metadata size too large: " + std::to_string(entry.metadata.size()) + 
                         " bytes for vector " + std::to_string(entry.vector_id));
            return false;
        }
        
        size_needed += fixed_entry_size + entry.metadata.size();
    }
    
    // Ensure we have enough space
    if (size_needed > (data_offset_ - vector_map_offset_)) {
        logger_.error("Vector map too large: " + std::to_string(size_needed) + 
                     " bytes needed, but only " + 
                     std::to_string(data_offset_ - vector_map_offset_) + " bytes available");
        return false;
    }
    
    // Write number of vectors
    uint32_t num_vectors = static_cast<uint32_t>(vector_map_.size());
    if (!writeAligned(&num_vectors, sizeof(num_vectors), vector_map_offset_)) {
        return false;
    }
    
    // Write each vector entry in chunks
    uint64_t offset = vector_map_offset_ + sizeof(uint32_t);
    
    // Define a reasonable chunk size (100 vectors per chunk)
    const uint32_t CHUNK_SIZE = 100;
    uint32_t i = 0;
    
    for (const auto& pair : vector_map_) {
        uint32_t vector_id = pair.first;
        const auto& entry = pair.second;
        
        // Write vector ID
        if (!writeAligned(&vector_id, sizeof(vector_id), offset)) {
            logger_.error("Failed to write vector ID at offset " + std::to_string(offset));
            return false;
        }
        offset += sizeof(vector_id);
        
        // Write cluster ID
        if (!writeAligned(&entry.cluster_id, sizeof(entry.cluster_id), offset)) {
            logger_.error("Failed to write cluster ID for vector " + std::to_string(vector_id));
            return false;
        }
        offset += sizeof(entry.cluster_id);
        
        // Write vector offset
        if (!writeAligned(&entry.offset, sizeof(entry.offset), offset)) {
            logger_.error("Failed to write vector offset for vector " + std::to_string(vector_id));
            return false;
        }
        offset += sizeof(entry.offset);
        
        // Write metadata size and data
        uint32_t metadata_size = static_cast<uint32_t>(entry.metadata.size());
        if (!writeAligned(&metadata_size, sizeof(metadata_size), offset)) {
            logger_.error("Failed to write metadata size for vector " + std::to_string(vector_id));
            return false;
        }
        offset += sizeof(metadata_size);
        
        if (metadata_size > 0) {
            if (!writeAligned(entry.metadata.c_str(), metadata_size, offset)) {
                logger_.error("Failed to write metadata for vector " + std::to_string(vector_id));
                return false;
            }
            offset += metadata_size;
        }
        
        i++;
        
        // Log progress for large vector maps
        if (num_vectors > CHUNK_SIZE && i % 1000 == 0) {
            logger_.debug("Wrote " + std::to_string(i) + "/" + std::to_string(num_vectors) + " vectors");
        }
    }
    
    logger_.debug("Wrote vector map: " + std::to_string(num_vectors) + " vectors");
    return true;
}

bool VectorClusterStore::readVectorMap() {
    if (fd_ < 0) {
        return false;
    }
    
    // Clear existing map
    vector_map_.clear();
    
    // Read number of vectors
    uint32_t num_vectors;
    if (!readAligned(&num_vectors, sizeof(num_vectors), vector_map_offset_)) {
        return false;
    }
    
    // Sanity check - limit maximum vectors to prevent excessive memory usage
    const uint32_t MAX_VECTORS = 1000000; // 1 million vectors max
    if (num_vectors > MAX_VECTORS) {
        logger_.error("Vector count too large: " + std::to_string(num_vectors) + 
                     ", maximum allowed: " + std::to_string(MAX_VECTORS));
        return false;
    }
    
    // Read each vector entry in chunks
    uint64_t offset = vector_map_offset_ + sizeof(uint32_t);
    
    // Define a reasonable chunk size (100 vectors per chunk)
    const uint32_t CHUNK_SIZE = 100;
    
    for (uint32_t i = 0; i < num_vectors;) {
        // Calculate how many vectors to read in this chunk
        uint32_t chunk_vectors = std::min(CHUNK_SIZE, num_vectors - i);
        
        for (uint32_t j = 0; j < chunk_vectors; j++, i++) {
            uint32_t vector_id;
            VectorEntry entry;
            
            // Read vector ID
            if (!readAligned(&vector_id, sizeof(vector_id), offset)) {
                logger_.error("Failed to read vector ID at offset " + std::to_string(offset));
                return false;
            }
            offset += sizeof(vector_id);
            
            entry.vector_id = vector_id;
            
            // Read cluster ID
            if (!readAligned(&entry.cluster_id, sizeof(entry.cluster_id), offset)) {
                logger_.error("Failed to read cluster ID for vector " + std::to_string(vector_id));
                return false;
            }
            offset += sizeof(entry.cluster_id);
            
            // Read vector offset
            if (!readAligned(&entry.offset, sizeof(entry.offset), offset)) {
                logger_.error("Failed to read vector offset for vector " + std::to_string(vector_id));
                return false;
            }
            offset += sizeof(entry.offset);
            
            // Read metadata size and data
            uint32_t metadata_size;
            if (!readAligned(&metadata_size, sizeof(metadata_size), offset)) {
                logger_.error("Failed to read metadata size for vector " + std::to_string(vector_id));
                return false;
            }
            offset += sizeof(metadata_size);
            
            // Sanity check metadata size
            const uint32_t MAX_METADATA_SIZE = 10240; // 10KB max per vector
            if (metadata_size > MAX_METADATA_SIZE) {
                logger_.error("Metadata size too large: " + std::to_string(metadata_size) + 
                             " bytes for vector " + std::to_string(vector_id));
                return false;
            }
            
            if (metadata_size > 0) {
                std::vector<char> metadata_buffer(metadata_size);
                if (!readAligned(metadata_buffer.data(), metadata_size, offset)) {
                    logger_.error("Failed to read metadata for vector " + std::to_string(vector_id));
                    return false;
                }
                entry.metadata.assign(metadata_buffer.data(), metadata_size);
                offset += metadata_size;
            }
            
            // Add to map
            vector_map_[vector_id] = entry;
            
            // Update next_vector_id if needed
            if (vector_id >= next_vector_id_) {
                next_vector_id_ = vector_id + 1;
            }
        }
        
        // Log progress for large vector maps
        if (num_vectors > CHUNK_SIZE && i % 1000 == 0) {
            logger_.debug("Read " + std::to_string(i) + "/" + std::to_string(num_vectors) + " vectors");
        }
    }
    
    logger_.debug("Read vector map: " + std::to_string(num_vectors) + " vectors");
    return true;
}

uint64_t VectorClusterStore::allocateVectorSpace(uint32_t cluster_id) {
    // Simplified implementation - in a real system, we would have a more sophisticated 
    // allocation strategy that groups vectors by cluster physically on the device
    
    // Calculate space needed for this vector
    size_t vector_size = vector_dim_ * sizeof(float);
    
    // For now, just append to the end of the data region
    static uint64_t next_offset = data_offset_;
    
    // Ensure alignment
    uint64_t aligned_offset = ((next_offset + block_size_ - 1) / block_size_) * block_size_;
    
    // Update next offset
    next_offset = aligned_offset + vector_size;
    
    return aligned_offset;
}

bool VectorClusterStore::writeVector(uint64_t offset, const Vector& vector) {
    if (fd_ < 0 || vector.size() != vector_dim_) {
        return false;
    }
    
    // Write vector data
    return writeAligned(vector.data(), vector.size() * sizeof(float), offset);
}

bool VectorClusterStore::readVector(uint64_t offset, Vector& vector) {
    if (fd_ < 0) {
        return false;
    }
    
    // Ensure vector has the right size
    vector.resize(vector_dim_);
    
    // Read vector data
    return readAligned(vector.data(), vector_dim_ * sizeof(float), offset);
}

void* VectorClusterStore::allocateAlignedBuffer(size_t size) {
    void* buffer = nullptr;
    size_t alignment = block_size_;
    
    // Ensure alignment is at least 512 bytes for direct I/O
    if (alignment < 512) alignment = 512;
    
    // Round up to block size
    size = ((size + alignment - 1) / alignment) * alignment;
    
    if (posix_memalign(&buffer, alignment, size) != 0) {
        logger_.error("Failed to allocate aligned memory: " + std::string(strerror(errno)));
        return nullptr;
    }
    
    return buffer;
}

bool VectorClusterStore::writeAligned(const void* buffer, size_t size, uint64_t offset) {
    if (fd_ < 0) {
        return false;
    }
    
    if (is_direct_io_) {
        // For direct I/O, we need to ensure alignment
        off_t aligned_offset = (offset / block_size_) * block_size_;
        size_t offset_adjustment = offset - aligned_offset;
        
        // Round up size to block boundary
        size_t aligned_size = ((size + offset_adjustment + block_size_ - 1) / block_size_) * block_size_;
        // Allocate aligned buffer
        void* aligned_buffer = allocateAlignedBuffer(aligned_size);
        if (!aligned_buffer) {
            return false;
        }
        
        // Clear buffer
        memset(aligned_buffer, 0, aligned_size);
        
        // If we're not at block boundary, we need to read existing data first
        if (offset_adjustment > 0 || (size % block_size_) != 0) {
            ssize_t bytes_read = pread(fd_, aligned_buffer, aligned_size, aligned_offset);
            if (bytes_read < 0) {
                logger_.error("Failed to read for read-modify-write: " + std::string(strerror(errno)));
                free(aligned_buffer);
                return false;
            }
        }
        
        // Copy data to aligned buffer
        memcpy(static_cast<char*>(aligned_buffer) + offset_adjustment, buffer, size);
        
        // Write aligned buffer
        ssize_t bytes_written = pwrite(fd_, aligned_buffer, aligned_size, aligned_offset);
        
        // Free aligned buffer
        free(aligned_buffer);
        
        if (bytes_written < 0) {
            logger_.error("Aligned write failed: " + std::string(strerror(errno)));
            return false;
        } else if (bytes_written != static_cast<ssize_t>(aligned_size)) {
            logger_.warning("Partial aligned write: " + std::to_string(bytes_written) + "/" + 
                           std::to_string(aligned_size) + " bytes");
            return false;
        }
        
        return true;
    } else {
        // Standard write
        ssize_t bytes_written = pwrite(fd_, buffer, size, offset);
        
        if (bytes_written < 0) {
            logger_.error("Write failed: " + std::string(strerror(errno)));
            return false;
        } else if (bytes_written != static_cast<ssize_t>(size)) {
            logger_.warning("Partial write: " + std::to_string(bytes_written) + "/" + 
                           std::to_string(size) + " bytes");
            return false;
        }
        
        return true;
    }
}

bool VectorClusterStore::readAligned(void* buffer, size_t size, uint64_t offset) {
    if (fd_ < 0) {
        return false;
    }
    
    if (is_direct_io_) {
        // For direct I/O, we need to ensure alignment
        off_t aligned_offset = (offset / block_size_) * block_size_;
        size_t offset_adjustment = offset - aligned_offset;
        
        // Round up size to block boundary
        size_t aligned_size = ((size + offset_adjustment + block_size_ - 1) / block_size_) * block_size_;
        
        // Allocate aligned buffer
        void* aligned_buffer = allocateAlignedBuffer(aligned_size);
        if (!aligned_buffer) {
            return false;
        }
        
        // Read aligned data
        ssize_t bytes_read = pread(fd_, aligned_buffer, aligned_size, aligned_offset);
        
        if (bytes_read < 0) {
            logger_.error("Aligned read failed: " + std::string(strerror(errno)));
            free(aligned_buffer);
            return false;
        } else if (bytes_read != static_cast<ssize_t>(aligned_size)) {
            logger_.warning("Partial aligned read: " + std::to_string(bytes_read) + "/" + 
                           std::to_string(aligned_size) + " bytes");
            free(aligned_buffer);
            return false;
        }
        
        // Copy to output buffer
        memcpy(buffer, static_cast<char*>(aligned_buffer) + offset_adjustment, size);
        
        // Free aligned bree(aligned_buffer);
        
        return true;
    } else {
        // Standard read
        ssize_t bytes_read = pread(fd_, buffer, size, offset);
        
        if (bytes_read < 0) {
            logger_.error("Read failed: " + std::string(strerror(errno)));
            return false;
        } else if (bytes_read != static_cast<ssize_t>(size)) {
            logger_.warning("Partial read: " + std::to_string(bytes_read) + "/" + 
                           std::to_string(size) + " bytes");
            return false;
        }
        
        return true;
    }
}

float VectorClusterStore::calculateCosineSimilarity(const Vector& v1, const Vector& v2) {
    if (v1.size() != v2.size()) {
        return 0.0f;
    }
    
    float dot_product = 0.0f;
    float norm1 = 0.0f;
    float norm2 = 0.0f;
    
    for (size_t i = 0; i < v1.size(); i++) {
        dot_product += v1[i] * v2[i];
        norm1 += v1[i] * v1[i];
        norm2 += v2[i] * v2[i];
    }
    
    if (norm1 == 0.0f || norm2 == 0.0f) {
        return 0.0f;
    }
    
    return dot_product / (std::sqrt(norm1) * std::sqrt(norm2));
}

float VectorClusterStore::calculateL2Distance(const Vector& v1, const Vector& v2) {
    if (v1.size() != v2.size()) {
        return std::numeric_limits<float>::max();
    }
    
    float sum = 0.0f;
    for (size_t i = 0; i < v1.size(); i++) {
        float diff = v1[i] - v2[i];
        sum += diff * diff;
    }
    
    return std::sqrt(sum);
}
