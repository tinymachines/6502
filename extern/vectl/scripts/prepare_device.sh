#!/bin/bash

# Device preparation script
# Usage: sudo ./prepare_device.sh /dev/sdX

set -e  # Exit on error

# Check if running with sudo
if [ "$EUID" -ne 0 ]; then
    echo "Error: This script must be run with sudo."
    echo "Usage: sudo $0 /dev/sdX"
    exit 1
fi

if [ "$#" -ne 1 ]; then
    echo "Usage: sudo $0 /dev/sdX"
    exit 1
fi

DEVICE="$1"
echo "===== Device Preparation Script ====="
echo "Target device: $DEVICE"

# Check if device exists
if [ ! -b "$DEVICE" ]; then
    echo "Error: Device $DEVICE does not exist or is not a block device."
    exit 1
fi

# Check if device is system disk
ROOT_DEVICE=$(df / | tail -1 | awk '{print $1}' | sed 's/[0-9]*$//')
if [[ "$DEVICE" == "$ROOT_DEVICE" ]]; then
    echo "Error: $DEVICE appears to be your system disk!"
    echo "Refusing to proceed to prevent system damage."
    exit 1
fi

# Confirmation
echo "⚠️  WARNING: All data on $DEVICE will be permanently erased!"
read -p "Are you absolutely sure you want to continue? (yes/no): " CONFIRM
if [[ "$CONFIRM" != "yes" ]]; then
    echo "Operation cancelled."
    exit 1
fi

# Unmount any mounted partitions from this device
echo "Unmounting any mounted partitions..."
mount | grep "$DEVICE" | awk '{print $1}' | while read partition; do
    echo "Unmounting $partition..."
    umount "$partition" || true
done

# Wipe existing partitions
echo "Wiping existing partitions..."
wipefs --all "$DEVICE"

# Display device information
echo "Device information after wiping:"
fdisk -l "$DEVICE"

echo "Device preparation completed successfully."
exit 0
