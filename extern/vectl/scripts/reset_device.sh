#!/bin/bash

# Reset device script
# Usage: sudo ./reset_device.sh /dev/sdX

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

echo "Resetting device $DEVICE..."
echo "⚠️  WARNING: All data on $DEVICE will be lost!"
read -p "Are you absolutely sure you want to continue? (yes/no): " CONFIRM
if [[ "$CONFIRM" != "yes" ]]; then
    echo "Operation cancelled."
    exit 1
fi

# Unmount any mounted partitions
echo "Unmounting any partitions..."
mount | grep "$DEVICE" | awk '{print $1}' | while read partition; do
    echo "Unmounting $partition..."
    umount "$partition" || true
done

# Wipe the first 100MB of the device (clears any existing header)
echo "Erasing the first 100MB of the device..."
dd if=/dev/zero of="$DEVICE" bs=1M count=100 status=progress
sync

echo "Device reset complete!"
