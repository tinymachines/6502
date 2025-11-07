#!/usr/bin/env python3

import sys
import ollama
import os
import json
import time
import glob
from datetime import datetime
from pathlib import Path

# Add the build directory to the path
sys.path.append(os.path.join(os.path.dirname(os.path.abspath(__file__)), "./repos/vectl/build"))

import vector_cluster_store_py

# Configuration
OLLAMA_API_URL = "http://127.0.0.1:11434/api/embed"
EMBEDDING_MODEL = "nomic-embed-text:latest"
VECTOR_DIM = 768  # Dimension of nomic-embed-text embeddings
DEVICE_PATH = "./vector_store.bin"  # Default to file-based storage
LOG_FILE = "./vector_store.log"  # Log file for the logger
METADATA_FILE = "./vector_store_metadata.json"

# Parse arguments
if len(sys.argv) < 5:
    print("Usage: python chunk_directory.py <directory_pattern> <base_id> <window_size> <overlap>")
    print("Example: python chunk_directory.py 'clean/1756083834/*.txt' 1000 10 5")
    sys.exit(1)

directory_pattern = sys.argv[1]
counter = int(sys.argv[2])
window_size = int(sys.argv[3])
overlap = int(sys.argv[4])

# Metadata management functions
def load_metadata():
    if os.path.exists(METADATA_FILE):
        try:
            with open(METADATA_FILE, 'r') as f:
                return json.load(f)
        except Exception as e:
            print(f"Error loading metadata: {e}")
    return {"next_id": counter, "entries": {}, "vector_dim": VECTOR_DIM}

def save_metadata(metadata):
    try:
        metadata["vector_dim"] = VECTOR_DIM
        with open(METADATA_FILE, 'w') as f:
            json.dump(metadata, f, indent=2)
    except Exception as e:
        print(f"Error saving metadata: {e}")

# Create a logger and initialize store
logger = vector_cluster_store_py.Logger(LOG_FILE)
store = vector_cluster_store_py.VectorClusterStore(logger)
store.initialize(DEVICE_PATH, "kmeans", VECTOR_DIM, 10)

# Load metadata
metadata = load_metadata()

def extract_file_info(filepath):
    """Extract metadata from filename and path."""
    path = Path(filepath)
    filename = path.name
    
    # Extract tool type from filename (lynx, guzl, curl)
    tool_type = "unknown"
    if "-lynx.txt" in filename:
        tool_type = "lynx"
    elif "-guzl.txt" in filename:
        tool_type = "guzl"
    elif "-curl.txt" in filename:
        tool_type = "curl"
    
    # Extract hash from filename
    hash_part = filename.split('-')[0]
    
    return {
        "filename": filename,
        "tool_type": tool_type,
        "content_hash": hash_part,
        "full_path": str(path),
        "file_size": path.stat().st_size if path.exists() else 0,
        "modified_time": datetime.fromtimestamp(path.stat().st_mtime).isoformat() if path.exists() else None
    }

def calculate_text_quality(text_chunk):
    """Calculate a simple quality score for text chunks."""
    words = text_chunk.split()
    word_count = len(words)
    
    if word_count < 5:  # Too short
        return 0.0
    
    # Quality metrics
    avg_word_length = sum(len(word) for word in words) / word_count if word_count > 0 else 0
    unique_words = len(set(word.lower() for word in words))
    uniqueness_ratio = unique_words / word_count if word_count > 0 else 0
    
    # Check for common UI noise patterns
    ui_noise_patterns = ['(BUTTON)', 'IFRAME:', 'Skip to', 'Log in', 'Subscribe', 'Watch later', 'Share', 'Copy link']
    noise_count = sum(1 for pattern in ui_noise_patterns if pattern.lower() in text_chunk.lower())
    noise_penalty = min(0.8, noise_count * 0.2)
    
    # Penalize very repetitive text
    if uniqueness_ratio < 0.3:
        return max(0.1, 0.2 - noise_penalty)
    
    # Reward reasonable word lengths and diversity
    base_quality = min(1.0, (avg_word_length / 6.0) * uniqueness_ratio)
    quality = max(0.1, base_quality - noise_penalty)
    
    return quality

def process_file(filepath, file_counter):
    """Process a single file and extract chunks."""
    print(f"\nProcessing file: {filepath}")
    
    try:
        with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
            content = f.readlines()
    except Exception as e:
        print(f"Error reading {filepath}: {e}")
        return file_counter
    
    if not content:
        print(f"Empty file: {filepath}")
        return file_counter
    
    file_info = extract_file_info(filepath)
    content_length = len(content)
    
    print(f"  Tool: {file_info['tool_type']}, Lines: {content_length}, Size: {file_info['file_size']} bytes")
    
    processed_chunks = 0
    quality_chunks = 0
    
    # Process chunks from this file
    for idx in range(0, max(1, content_length - window_size + 1), overlap):
        # Make a chunk
        end = min(idx + window_size, content_length)
        chunk_text = "".join(content[idx:end]).strip()
        
        if not chunk_text:
            continue
            
        # Calculate quality score
        quality_score = calculate_text_quality(chunk_text)
        
        # Skip low-quality chunks (more aggressive for directory processing)
        if quality_score < 0.4:
            processed_chunks += 1
            continue

        # Get embedding
        try:
            response = ollama.embed(
                model=EMBEDDING_MODEL,
                input=chunk_text,
            )
            embeddings = response["embeddings"][0]
        except Exception as e:
            print(f"    Error getting embedding for chunk {processed_chunks}: {e}")
            processed_chunks += 1
            continue

        # Enhanced metadata with file info
        chunk_metadata = {
            "source_type": "directory",
            "source_file": file_info["filename"],
            "full_path": file_info["full_path"],
            "tool_type": file_info["tool_type"],
            "content_hash": file_info["content_hash"],
            "start_line": idx,
            "end_line": end,
            "window_size": window_size,
            "overlap": overlap,
            "quality_score": quality_score,
            "text_preview": chunk_text[:100] + "..." if len(chunk_text) > 100 else chunk_text,
            "word_count": len(chunk_text.split()),
            "timestamp": datetime.now().isoformat(),
            "embedding_model": EMBEDDING_MODEL,
            "file_size": file_info["file_size"],
            "file_modified": file_info["modified_time"]
        }
        
        metadata_json = json.dumps(chunk_metadata)

        # Store vector
        try:
            result = store.store_vector(file_counter, embeddings, metadata_json)
            if result:
                # Update global metadata
                metadata["entries"][str(file_counter)] = chunk_metadata
                metadata["next_id"] = file_counter + 1
                quality_chunks += 1
                
                if quality_chunks % 10 == 0:  # Progress indicator
                    print(f"    Stored {quality_chunks} quality chunks...")
            else:
                print(f"    Failed to store chunk {file_counter}")
        except Exception as e:
            print(f"    Error storing chunk {file_counter}: {e}")

        file_counter += 1
        processed_chunks += 1
    
    print(f"  File complete: {processed_chunks} processed, {quality_chunks} stored (retention: {quality_chunks/processed_chunks*100:.1f}%)" if processed_chunks > 0 else "  No chunks processed")
    return file_counter

# Main processing
print("="*60)
print("DIRECTORY INGESTION PIPELINE")
print("="*60)
print(f"Pattern: {directory_pattern}")
print(f"Window size: {window_size}, Overlap: {overlap}")
print(f"Starting vector ID: {counter}")

# Find matching files
file_paths = glob.glob(directory_pattern)
file_paths.sort()  # Process in consistent order

if not file_paths:
    print(f"No files found matching pattern: {directory_pattern}")
    sys.exit(1)

print(f"Found {len(file_paths)} files to process")

# Process statistics
total_files = len(file_paths)
processed_files = 0
total_chunks_processed = 0
total_quality_chunks = 0
start_time = time.time()

# Process each file
current_counter = counter
for i, filepath in enumerate(file_paths, 1):
    print(f"\n[{i}/{total_files}] Processing: {os.path.basename(filepath)}")
    
    chunks_before = len([k for k in metadata["entries"].keys() if int(k) >= counter])
    new_counter = process_file(filepath, current_counter)
    chunks_after = len([k for k in metadata["entries"].keys() if int(k) >= counter])
    
    file_chunks_added = chunks_after - chunks_before
    total_quality_chunks += file_chunks_added
    
    current_counter = new_counter
    processed_files += 1

# Save final metadata
save_metadata(metadata)

# Print comprehensive summary
end_time = time.time()
elapsed_time = end_time - start_time

print("\n" + "="*60)
print("DIRECTORY INGESTION COMPLETE")
print("="*60)
print(f"Files processed: {processed_files}/{total_files}")
print(f"Total quality chunks stored: {total_quality_chunks}")
print(f"Vector IDs used: {counter} to {current_counter-1}")
print(f"Processing time: {elapsed_time:.1f}s ({elapsed_time/processed_files:.1f}s per file)")
print(f"Average chunks per file: {total_quality_chunks/processed_files:.1f}" if processed_files > 0 else "No files processed")

# File type breakdown
tool_counts = {}
for entry in metadata["entries"].values():
    if "tool_type" in entry:
        tool_type = entry["tool_type"]
        tool_counts[tool_type] = tool_counts.get(tool_type, 0) + 1

if tool_counts:
    print(f"\nFile type breakdown:")
    for tool_type, count in sorted(tool_counts.items()):
        print(f"  {tool_type}: {count} chunks")

print(f"\nNext vector ID: {current_counter}")
print("Ready for semantic recovery pipeline!")
