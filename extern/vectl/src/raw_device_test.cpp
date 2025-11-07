#include <iostream>
#include <fstream>
#include <string>
#include <vector>
#include <cstring>
#include <cstdlib>
#include <cstdio>
#include <cerrno>
#include <fcntl.h>
#include <unistd.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <linux/fs.h>
#include <stdint.h>
#include <chrono>
#include <iomanip>
#include <sstream>

// Log levels
enum LogLevel {
    DEBUG,
    INFO,
    WARNING,
    ERROR
};

class Logger {
private:
    LogLevel level_;
    std::ofstream logFile_;
    bool console_;

public:
    Logger(const std::string& filename, LogLevel level = INFO, bool console = true) 
        : level_(level), console_(console) {
        logFile_.open(filename, std::ios::out | std::ios::app);
        if (!logFile_.is_open()) {
            std::cerr << "Failed to open log file: " << filename << std::endl;
        }
    }
    
    ~Logger() {
        if (logFile_.is_open()) {
            logFile_.close();
        }
    }
    
    void log(LogLevel msgLevel, const std::string& message) {
        if (msgLevel < level_) return;
        
        auto now = std::chrono::system_clock::now();
        auto now_c = std::chrono::system_clock::to_time_t(now);
        auto now_tm = std::localtime(&now_c);
        
        std::string levelStr;
        switch (msgLevel) {
            case DEBUG:   levelStr = "DEBUG"; break;
            case INFO:    levelStr = "INFO"; break;
            case WARNING: levelStr = "WARNING"; break;
            case ERROR:   levelStr = "ERROR"; break;
        }
        
        std::stringstream log_entry;
        log_entry << "[" 
                  << std::put_time(now_tm, "%Y-%m-%d %H:%M:%S") 
                  << "] [" << levelStr << "] " 
                  << message;
        
        if (logFile_.is_open()) {
            logFile_ << log_entry.str() << std::endl;
        }
        
        if (console_) {
            if (msgLevel == ERROR) {
                std::cerr << log_entry.str() << std::endl;
            } else {
                std::cout << log_entry.str() << std::endl;
            }
        }
    }
    
    void debug(const std::string& message) { log(DEBUG, message); }
    void info(const std::string& message) { log(INFO, message); }
    void warning(const std::string& message) { log(WARNING, message); }
    void error(const std::string& message) { log(ERROR, message); }
};

class RawDeviceTest {
private:
    std::string devicePath_;
    int deviceFd_;
    uint64_t deviceSize_;
    uint32_t blockSize_;
    Logger& logger_;

public:
    RawDeviceTest(Logger& logger) 
        : devicePath_(""), deviceFd_(-1), deviceSize_(0), blockSize_(0), logger_(logger) {}
    
    ~RawDeviceTest() {
        closeDevice();
    }
    
    bool setDevice(const std::string& path) {
        logger_.info("Setting device to: " + path);
        devicePath_ = path;
        return true;
    }
    
    bool openDevice(bool readOnly = false) {
        if (devicePath_.empty()) {
            logger_.error("No device selected");
            return false;
        }
        
        if (deviceFd_ >= 0) {
            closeDevice();
        }
        
        int flags = readOnly ? O_RDONLY : O_RDWR;
        // Note: No O_DIRECT flag initially to diagnose issues
        
        logger_.debug("Opening device: " + devicePath_ + " with flags: " + std::to_string(flags));
        deviceFd_ = open(devicePath_.c_str(), flags);
        
        if (deviceFd_ < 0) {
            logger_.error("Failed to open device: " + devicePath_ + ", error: " + strerror(errno));
            return false;
        }
        
        // Get device size
        if (ioctl(deviceFd_, BLKGETSIZE64, &deviceSize_) < 0) {
            logger_.error("Failed to get device size: " + std::string(strerror(errno)));
            closeDevice();
            return false;
        }
        
        // Get block size
        if (ioctl(deviceFd_, BLKSSZGET, &blockSize_) < 0) {
            logger_.error("Failed to get block size: " + std::string(strerror(errno)));
            closeDevice();
            return false;
        }
        
        logger_.info("Device opened successfully");
        logger_.info("Device size: " + std::to_string(deviceSize_) + " bytes");
        logger_.info("Block size: " + std::to_string(blockSize_) + " bytes");
        
        return true;
    }
    
    bool openDeviceWithDirectIO(bool readOnly = false) {
        if (devicePath_.empty()) {
            logger_.error("No device selected");
            return false;
        }
        
        if (deviceFd_ >= 0) {
            closeDevice();
        }
        
        int flags = readOnly ? O_RDONLY : O_RDWR;
        flags |= O_DIRECT;  // Add O_DIRECT flag
        
        logger_.debug("Opening device with O_DIRECT: " + devicePath_ + " with flags: " + std::to_string(flags));
        deviceFd_ = open(devicePath_.c_str(), flags);
        
        if (deviceFd_ < 0) {
            logger_.error("Failed to open device with O_DIRECT: " + devicePath_ + ", error: " + strerror(errno));
            return false;
        }
        
        // Get device size
        if (ioctl(deviceFd_, BLKGETSIZE64, &deviceSize_) < 0) {
            logger_.error("Failed to get device size: " + std::string(strerror(errno)));
            closeDevice();
            return false;
        }
        
        // Get block size
        if (ioctl(deviceFd_, BLKSSZGET, &blockSize_) < 0) {
            logger_.error("Failed to get block size: " + std::string(strerror(errno)));
            closeDevice();
            return false;
        }
        
        logger_.info("Device opened successfully with O_DIRECT");
        logger_.info("Device size: " + std::to_string(deviceSize_) + " bytes");
        logger_.info("Block size: " + std::to_string(blockSize_) + " bytes");
        
        return true;
    }
    
    void closeDevice() {
        if (deviceFd_ >= 0) {
            logger_.debug("Closing device: " + devicePath_);
            close(deviceFd_);
            deviceFd_ = -1;
        }
    }
    
    bool isDeviceOpen() const {
        return deviceFd_ >= 0;
    }
    
    // Allocate aligned memory for direct I/O
    void* allocateAlignedBuffer(size_t size) {
        void* buffer = nullptr;
        size_t alignment = blockSize_;
        
        // Ensure alignment is at least 512 bytes for direct I/O
        if (alignment < 512) alignment = 512;
        
        logger_.debug("Allocating aligned buffer of size " + std::to_string(size) + 
                     " with alignment " + std::to_string(alignment));
        
        if (posix_memalign(&buffer, alignment, size) != 0) {
            logger_.error("Failed to allocate aligned memory: " + std::string(strerror(errno)));
            return nullptr;
        }
        
        return buffer;
    }
    
    // Write data to device at given offset
    bool writeData(const void* data, size_t size, off_t offset) {
        if (!isDeviceOpen()) {
            logger_.error("Device not open");
            return false;
        }
        
        logger_.debug("Writing " + std::to_string(size) + " bytes at offset " + std::to_string(offset));
        
        ssize_t bytes_written = pwrite(deviceFd_, data, size, offset);
        if (bytes_written < 0) {
            logger_.error("Write failed: " + std::string(strerror(errno)));
            return false;
        } else if (bytes_written != static_cast<ssize_t>(size)) {
            logger_.warning("Partial write: " + std::to_string(bytes_written) + "/" + std::to_string(size) + " bytes");
            return false;
        }
        
        logger_.debug("Successfully wrote " + std::to_string(bytes_written) + " bytes");
        return true;
    }
    
    // Read data from device at given offset
    bool readData(void* buffer, size_t size, off_t offset) {
        if (!isDeviceOpen()) {
            logger_.error("Device not open");
            return false;
        }
        
        logger_.debug("Reading " + std::to_string(size) + " bytes at offset " + std::to_string(offset));
        
        ssize_t bytes_read = pread(deviceFd_, buffer, size, offset);
        if (bytes_read < 0) {
            logger_.error("Read failed: " + std::string(strerror(errno)));
            return false;
        } else if (bytes_read != static_cast<ssize_t>(size)) {
            logger_.warning("Partial read: " + std::to_string(bytes_read) + "/" + std::to_string(size) + " bytes");
            return false;
        }
        
        logger_.debug("Successfully read " + std::to_string(bytes_read) + " bytes");
        return true;
    }
    
    // Write with alignment handling for direct I/O
    bool writeAligned(const void* data, size_t size, off_t offset) {
        if (!isDeviceOpen()) {
            logger_.error("Device not open");
            return false;
        }
        
        // Calculate aligned offset and adjustment
        off_t aligned_offset = (offset / blockSize_) * blockSize_;
        size_t offset_adjustment = offset - aligned_offset;
        
        // Calculate total size needed for the aligned buffer
        size_t aligned_size = ((size + offset_adjustment + blockSize_ - 1) / blockSize_) * blockSize_;
        
        logger_.debug("Write request: size=" + std::to_string(size) + 
                     ", offset=" + std::to_string(offset));
        logger_.debug("Aligned write: aligned_offset=" + std::to_string(aligned_offset) + 
                     ", offset_adjustment=" + std::to_string(offset_adjustment) + 
                     ", aligned_size=" + std::to_string(aligned_size));
        
        // Allocate aligned buffer
        void* aligned_buffer = allocateAlignedBuffer(aligned_size);
        if (!aligned_buffer) {
            return false;
        }
        
        // Clear buffer
        memset(aligned_buffer, 0, aligned_size);
        
        // If we're not at block boundary, we need to read existing data first
        if (offset_adjustment > 0 || (size % blockSize_) != 0) {
            logger_.debug("Performing read-modify-write operation");
            
            if (pread(deviceFd_, aligned_buffer, aligned_size, aligned_offset) != static_cast<ssize_t>(aligned_size)) {
                logger_.error("Failed to read existing data for read-modify-write: " + 
                             std::string(strerror(errno)));
                free(aligned_buffer);
                return false;
            }
        }
        
        // Copy new data into aligned buffer at the right position
        memcpy(static_cast<char*>(aligned_buffer) + offset_adjustment, data, size);
        
        // Write aligned buffer
        ssize_t bytes_written = pwrite(deviceFd_, aligned_buffer, aligned_size, aligned_offset);
        
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
        
        logger_.debug("Successfully performed aligned write of " + std::to_string(bytes_written) + " bytes");
        return true;
    }
    
    // Read with alignment handling for direct I/O
    bool readAligned(void* buffer, size_t size, off_t offset) {
        if (!isDeviceOpen()) {
            logger_.error("Device not open");
            return false;
        }
        
        // Calculate aligned offset and adjustment
        off_t aligned_offset = (offset / blockSize_) * blockSize_;
        size_t offset_adjustment = offset - aligned_offset;
        
        // Calculate total size needed for the aligned buffer
        size_t aligned_size = ((size + offset_adjustment + blockSize_ - 1) / blockSize_) * blockSize_;
        
        logger_.debug("Read request: size=" + std::to_string(size) + 
                     ", offset=" + std::to_string(offset));
        logger_.debug("Aligned read: aligned_offset=" + std::to_string(aligned_offset) + 
                     ", offset_adjustment=" + std::to_string(offset_adjustment) + 
                     ", aligned_size=" + std::to_string(aligned_size));
        
        // Allocate aligned buffer
        void* aligned_buffer = allocateAlignedBuffer(aligned_size);
        if (!aligned_buffer) {
            return false;
        }
        
        // Read into aligned buffer
        ssize_t bytes_read = pread(deviceFd_, aligned_buffer, aligned_size, aligned_offset);
        
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
        
        // Copy from aligned buffer to destination
        memcpy(buffer, static_cast<char*>(aligned_buffer) + offset_adjustment, size);
        
        // Free aligned buffer
        free(aligned_buffer);
        
        logger_.debug("Successfully performed aligned read of " + std::to_string(size) + " bytes");
        return true;
    }
    
    // Run device preparation script
    bool prepareDevice(const std::string& scriptPath) {
        logger_.info("Preparing device: " + devicePath_ + " using script: " + scriptPath);
        
        // Close device if open
        if (isDeviceOpen()) {
            closeDevice();
        }
        
        // Build command string
        std::string command = scriptPath + " " + devicePath_ + " 2>&1";
        logger_.debug("Running command: " + command);
        
        // Execute command
        FILE* pipe = popen(command.c_str(), "r");
        if (!pipe) {
            logger_.error("Failed to execute preparation script: " + std::string(strerror(errno)));
            return false;
        }
        
        // Read and log output
        char buffer[256];
        std::string result = "";
        while (!feof(pipe)) {
            if (fgets(buffer, sizeof(buffer), pipe) != nullptr) {
                result += buffer;
            }
        }
        
        int status = pclose(pipe);
        if (status != 0) {
            logger_.error("Preparation script failed with status: " + std::to_string(status));
            logger_.error("Script output: " + result);
            return false;
        }
        
        logger_.info("Device preparation completed successfully");
        logger_.debug("Script output: " + result);
        
        return true;
    }
    
    // Print device info
    void printDeviceInfo() {
        if (!isDeviceOpen()) {
            logger_.error("Device not open");
            return;
        }
        
        logger_.info("=== Device Information ===");
        logger_.info("Device path: " + devicePath_);
        logger_.info("Device size: " + std::to_string(deviceSize_) + " bytes (" + 
                    std::to_string(deviceSize_ / (1024*1024)) + " MB)");
        logger_.info("Block size: " + std::to_string(blockSize_) + " bytes");
    }
    
    // Test write with different patterns and sizes
    bool testWrite(size_t blockCount = 10) {
        if (!isDeviceOpen()) {
            logger_.error("Device not open");
            return false;
        }
        
        size_t testSize = blockSize_ * blockCount;
        logger_.info("Running write test with " + std::to_string(blockCount) + 
                   " blocks (" + std::to_string(testSize) + " bytes)");
        
        // Allocate buffer
        void* buffer = allocateAlignedBuffer(testSize);
        if (!buffer) {
            return false;
        }
        
        // Fill with pattern
        for (size_t i = 0; i < testSize; i++) {
            static_cast<uint8_t*>(buffer)[i] = i & 0xFF;
        }
        
        // Test standard write
        logger_.info("1. Testing standard write at offset 0");
        bool standardWriteResult = writeData(buffer, testSize, 0);
        logger_.info("Standard write result: " + std::string(standardWriteResult ? "Success" : "Failure"));
        
        // Test aligned write
        logger_.info("2. Testing aligned write at offset " + std::to_string(blockSize_));
        bool alignedWriteResult = writeAligned(buffer, testSize, blockSize_);
        logger_.info("Aligned write result: " + std::string(alignedWriteResult ? "Success" : "Failure"));
        
        // Test unaligned write
        size_t unalignedOffset = blockSize_ + 123; // Deliberately unaligned
        logger_.info("3. Testing unaligned write at offset " + std::to_string(unalignedOffset));
        bool unalignedWriteResult = writeAligned(buffer, testSize, unalignedOffset);
        logger_.info("Unaligned write result: " + std::string(unalignedWriteResult ? "Success" : "Failure"));
        
        // Free buffer
        free(buffer);
        
        return standardWriteResult && alignedWriteResult && unalignedWriteResult;
    }
    
    // Test read after write to verify data integrity
    bool testReadAfterWrite(size_t blockCount = 10) {
        if (!isDeviceOpen()) {
            logger_.error("Device not open");
            return false;
        }
        
        size_t testSize = blockSize_ * blockCount;
        logger_.info("Running read-after-write test with " + std::to_string(blockCount) + 
                   " blocks (" + std::to_string(testSize) + " bytes)");
        
        // Allocate write buffer
        void* writeBuffer = allocateAlignedBuffer(testSize);
        if (!writeBuffer) {
            return false;
        }
        
        // Fill with pattern
        for (size_t i = 0; i < testSize; i++) {
            static_cast<uint8_t*>(writeBuffer)[i] = (i * 7) & 0xFF; // Unique pattern
        }
        
        // Allocate read buffer
        void* readBuffer = allocateAlignedBuffer(testSize);
        if (!readBuffer) {
            free(writeBuffer);
            return false;
        }
        
        // Test locations
        std::vector<off_t> testOffsets = {
           0,                   // Start of device
            blockSize_,          // Aligned to block size
            blockSize_ + 123,    // Unaligned offset
            10 * blockSize_      // Further into the device
        };
        
        bool overallSuccess = true;
        
        for (size_t i = 0; i < testOffsets.size(); i++) {
            off_t offset = testOffsets[i];
            logger_.info("Test " + std::to_string(i+1) + ": Read-write at offset " + std::to_string(offset));
            
            // Clear read buffer
            memset(readBuffer, 0, testSize);
            
            // Write data
            bool writeResult = writeAligned(writeBuffer, testSize, offset);
            if (!writeResult) {
                logger_.error("Write failed at offset " + std::to_string(offset));
                overallSuccess = false;
                continue;
            }
            
            // Sync to ensure data is written
            fsync(deviceFd_);
            
            // Read data back
            bool readResult = readAligned(readBuffer, testSize, offset);
            if (!readResult) {
                logger_.error("Read failed at offset " + std::to_string(offset));
                overallSuccess = false;
                continue;
            }
            
            // Verify data
            bool match = (memcmp(writeBuffer, readBuffer, testSize) == 0);
            if (!match) {
                logger_.error("Data verification failed at offset " + std::to_string(offset));
                
                // Print first few bytes for comparison
                std::stringstream ss;
                ss << "First 16 bytes - Written: ";
                for (size_t j = 0; j < 16 && j < testSize; j++) {
                    ss << std::hex << std::setw(2) << std::setfill('0') 
                       << static_cast<int>(static_cast<uint8_t*>(writeBuffer)[j]) << " ";
                }
                ss << ", Read: ";
                for (size_t j = 0; j < 16 && j < testSize; j++) {
                    ss << std::hex << std::setw(2) << std::setfill('0') 
                       << static_cast<int>(static_cast<uint8_t*>(readBuffer)[j]) << " ";
                }
                logger_.error(ss.str());
                
                overallSuccess = false;
            } else {
                logger_.info("Data verification succeeded at offset " + std::to_string(offset));
            }
        }
        
        // Free buffers
        free(writeBuffer);
        free(readBuffer);
        
        return overallSuccess;
    }
};

void showHelp() {
    std::cout << "Raw Block Device Test Harness" << std::endl;
    std::cout << "============================" << std::endl;
    std::cout << "Available commands:" << std::endl;
    std::cout << "  1. Set device path" << std::endl;
    std::cout << "  2. Open device (standard)" << std::endl;
    std::cout << "  3. Open device (with O_DIRECT)" << std::endl;
    std::cout << "  4. Close device" << std::endl;
    std::cout << "  5. Display device info" << std::endl;
    std::cout << "  6. Prepare device (run script)" << std::endl;
    std::cout << "  7. Test write operations" << std::endl;
    std::cout << "  8. Test read-after-write operations" << std::endl;
    std::cout << "  9. Custom read/write test" << std::endl;
    std::cout << "  0. Exit" << std::endl;
    std::cout << "============================" << std::endl;
}

int main() {
    // Initialize logger
    Logger logger("raw_device_test.log", DEBUG);
    logger.info("Raw Block Device Test Harness started");
    
    // Create test harness
    RawDeviceTest tester(logger);
    
    std::string devicePath;
    std::string scriptPath;
    std::string input;
    int choice = -1;
    
    while (choice != 0) {
        showHelp();
        std::cout << "Enter choice: ";
        std::getline(std::cin, input);
        
        try {
            choice = std::stoi(input);
        } catch (...) {
            std::cout << "Invalid input. Please enter a number." << std::endl;
            choice = -1;
            continue;
        }
        
        switch (choice) {
            case 0: // Exit
                logger.info("Exiting program");
                break;
                
            case 1: // Set device path
                std::cout << "Enter device path (e.g., /dev/sdb): ";
                std::getline(std::cin, devicePath);
                tester.setDevice(devicePath);
                break;
                
            case 2: // Open device (standard)
                if (tester.openDevice()) {
                    std::cout << "Device opened successfully." << std::endl;
                } else {
                    std::cout << "Failed to open device." << std::endl;
                }
                break;
                
            case 3: // Open device (with O_DIRECT)
                if (tester.openDeviceWithDirectIO()) {
                    std::cout << "Device opened successfully with O_DIRECT." << std::endl;
                } else {
                    std::cout << "Failed to open device with O_DIRECT." << std::endl;
                }
                break;
                
            case 4: // Close device
                tester.closeDevice();
                std::cout << "Device closed." << std::endl;
                break;
                
            case 5: // Display device info
                tester.printDeviceInfo();
                break;
                
            case 6: // Prepare device
                std::cout << "Enter script path: ";
                std::getline(std::cin, scriptPath);
                if (tester.prepareDevice(scriptPath)) {
                    std::cout << "Device prepared successfully." << std::endl;
                } else {
                    std::cout << "Failed to prepare device." << std::endl;
                }
                break;
                
            case 7: // Test write operations
                if (tester.testWrite()) {
                    std::cout << "Write tests completed successfully." << std::endl;
                } else {
                    std::cout << "Write tests failed." << std::endl;
                }
                break;
                
            case 8: // Test read-after-write operations
                if (tester.testReadAfterWrite()) {
                    std::cout << "Read-after-write tests completed successfully." << std::endl;
                } else {
                    std::cout << "Read-after-write tests failed." << std::endl;
                }
                break;
                
            case 9: { // Custom read/write test
                std::string offsetStr, sizeStr;
                
                std::cout << "Enter offset: ";
                std::getline(std::cin, offsetStr);
                
                std::cout << "Enter size (in bytes): ";
                std::getline(std::cin, sizeStr);
                
                off_t offset;
                size_t size;
                
                try {
                    offset = std::stoll(offsetStr);
                    size = std::stoull(sizeStr);
                } catch (...) {
                    std::cout << "Invalid input." << std::endl;
                    break;
                }
                
                // Allocate buffers
                void* writeBuffer = tester.allocateAlignedBuffer(size);
                void* readBuffer = tester.allocateAlignedBuffer(size);
                
                if (!writeBuffer || !readBuffer) {
                    std::cout << "Failed to allocate buffers." << std::endl;
                    if (writeBuffer) free(writeBuffer);
                    if (readBuffer) free(readBuffer);
                    break;
                }
                
                // Fill write buffer with pattern
                for (size_t i = 0; i < size; i++) {
                    static_cast<uint8_t*>(writeBuffer)[i] = i & 0xFF;
                }
                
                // Write
                bool writeResult = tester.writeAligned(writeBuffer, size, offset);
                if (writeResult) {
                    std::cout << "Write successful." << std::endl;
                } else {
                    std::cout << "Write failed." << std::endl;
                }
                
                // Sync
                fsync(tester.isDeviceOpen() ? tester.isDeviceOpen() : -1);
                
                // Read back
                bool readResult = tester.readAligned(readBuffer, size, offset);
                if (readResult) {
                    std::cout << "Read successful." << std::endl;
                } else {
                    std::cout << "Read failed." << std::endl;
                }
                
                // Verify
                if (writeResult && readResult) {
                    bool match = (memcmp(writeBuffer, readBuffer, size) == 0);
                    if (match) {
                        std::cout << "Data verification succeeded." << std::endl;
                    } else {
                        std::cout << "Data verification failed." << std::endl;
                    }
                }
                
                // Free buffers
                free(writeBuffer);
                free(readBuffer);
                break;
            }
                
            default:
                std::cout << "Invalid choice." << std::endl;
                break;
        }
        
        std::cout << std::endl;
    }
    
    return 0;
}
