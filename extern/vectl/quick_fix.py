#!/usr/bin/env python3

import json
import os
import sys

def truncate_metadata_to_working_vectors(metadata_file, max_safe_id=1300):
    """
    Truncate metadata to only include vectors that were working before corruption.
    Based on the error, vectors after ~1000 are corrupted.
    """
    print(f"🔧 Loading metadata from {metadata_file}")
    
    with open(metadata_file, 'r') as f:
        metadata = json.load(f)
    
    original_count = len(metadata['entries'])
    print(f"📊 Original metadata has {original_count} entries")
    
    # Filter to keep only safe vector IDs (before corruption started)
    safe_entries = {}
    for vector_id, entry in metadata['entries'].items():
        if int(vector_id) <= max_safe_id:
            safe_entries[vector_id] = entry
    
    # Update metadata
    metadata['entries'] = safe_entries
    metadata['next_id'] = max(int(vid) for vid in safe_entries.keys()) + 1 if safe_entries else 1000
    
    safe_count = len(safe_entries)
    print(f"✅ Keeping {safe_count} safe entries (removed {original_count - safe_count} corrupted)")
    
    # Save truncated metadata
    backup_file = metadata_file + '.truncated'
    with open(backup_file, 'w') as f:
        json.dump(metadata, f, indent=2)
    
    print(f"💾 Saved truncated metadata to: {backup_file}")
    return backup_file

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python3 quick_fix.py <metadata_file>")
        print("Example: python3 quick_fix.py vector_store_metadata.json")
        sys.exit(1)
    
    metadata_file = sys.argv[1]
    
    if not os.path.exists(metadata_file):
        print(f"❌ Metadata file not found: {metadata_file}")
        sys.exit(1)
    
    print("=== Quick Fix for Vector Store Corruption ===")
    truncated_file = truncate_metadata_to_working_vectors(metadata_file)
    
    print(f"""
🎯 Next Steps:
1. Backup your current files:
   cp vector_store.bin vector_store.bin.backup
   cp vector_store_metadata.json vector_store_metadata.json.backup

2. Remove the corrupted store:
   rm vector_store.bin

3. Use the truncated metadata:
   cp {truncated_file} vector_store_metadata.json

4. Re-run your ollama script to rebuild the store with clean data:
   python3 ollama_vector_search.py ./vector_store.bin

The new store will only contain the non-corrupted vectors and will work correctly!
""")