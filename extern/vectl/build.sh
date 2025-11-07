#!/bin/bash
set -e  # Exit on error

# Color definitions for better readability
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== VectorClusterStore Build Script ===${NC}"

# Clean function for removing previous build artifacts
clean() {
    echo -e "${YELLOW}Cleaning previous build artifacts...${NC}"
    
    # Remove build directory if it exists
    if [ -d "build" ]; then
        echo "Removing build directory..."
        rm -rf build/
    fi
    
    # Remove compiled objects
    echo "Removing object files..."
    find . -name "*.o" -type f -delete
    
    # Remove compiled libraries
    echo "Removing compiled libraries..."
    find . -name "*.so" -type f -delete
    find . -name "*.a" -type f -delete
    find . -name "*.dylib" -type f -delete
    
    # Remove Python compilation artifacts
    echo "Removing Python compilation artifacts..."
    find . -name "__pycache__" -type d -exec rm -rf {} +  2>/dev/null || true
    find . -name "*.pyc" -type f -delete
    find . -name "*.pyo" -type f -delete
    find . -name "*.pyd" -type f -delete
    find . -name ".pytest_cache" -type d -exec rm -rf {} + 2>/dev/null || true
    find . -name "*.egg-info" -type d -exec rm -rf {} + 2>/dev/null || true
    
    # Remove CMake cache files
    echo "Removing CMake cache files..."
    find . -name "CMakeCache.txt" -type f -delete
    find . -name "CMakeFiles" -type d -exec rm -rf {} + 2>/dev/null || true
    
    echo -e "${GREEN}Clean completed successfully!${NC}"
}

# Build function
build() {
    echo -e "${YELLOW}Starting build process...${NC}"
    
    # Create build directory
    mkdir -p build
    cd build
    
    # Configure with CMake
    echo "Configuring with CMake..."
    cmake ..
    
    # Build with all available cores
    echo "Building..."
    make -j$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 2)
    
    cd ..
    
    echo -e "${GREEN}Build completed successfully!${NC}"
    
    # Verify binary files were created
    if [ -f "build/test_cluster_store" ] && [ -f "build/raw_device_test" ] && [ -f "build/vector_store_test" ]; then
        echo -e "${GREEN}Generated executables:${NC}"
        echo " - build/test_cluster_store"
        echo " - build/raw_device_test"
        echo " - build/vector_store_test"
        if [ -f "build/fastcomp" ]; then
            echo " - build/fastcomp"
        fi
    else
        echo -e "${RED}Warning: Some expected executables were not created.${NC}"
    fi
    
    # Check for the Python module
    if [ -f "build/vector_cluster_store_py"*".so" ]; then
        echo -e "${GREEN}Generated Python module:${NC}"
        ls -la build/vector_cluster_store_py*.so
    else
        echo -e "${YELLOW}Warning: Python module was not created.${NC}"
        echo "Run 'pip install -e .' to build the Python module"
    fi
}

# Parse command line arguments
if [ "$1" = "clean" ]; then
    clean
    exit 0
elif [ "$1" = "rebuild" ]; then
    clean
    build
    exit 0
fi

# Default action is build (with clean)
clean
build

echo -e "\n${GREEN}=== Build Process Complete ===${NC}"
echo "To clean only: ./build.sh clean"
echo "To rebuild all: ./build.sh rebuild"
echo "To install Python package: pip install -e ."
