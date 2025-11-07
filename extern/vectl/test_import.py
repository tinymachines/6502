#!/usr/bin/env python3
import sys
import os
from pathlib import Path

# Add the build directory to the Python path
build_dir = Path(__file__).parent / "build"
sys.path.append(str(build_dir))

# List available modules in the build directory
print(f"Looking for modules in: {build_dir}")
for file in build_dir.glob("*.so"):
    print(f"Found module: {file.name}")

# Try to import the module
try:
    import vector_cluster_store_py
    print("Successfully imported vector_cluster_store_py")
    
    # Test creating objects
    logger = vector_cluster_store_py.Logger("test_import.log")
    print("Created logger object")
    
    store = vector_cluster_store_py.VectorClusterStore(logger)
    print("Created store object")
    
except ImportError as e:
    print(f"Import error: {e}")
    
    # Get more detailed error info
    import traceback
    traceback.print_exc()
