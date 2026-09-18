#!/bin/bash
# Mount RAMDisk tmpfs cho HLS live của VTCAIO (Prod). Dev dùng ./storage/ramdisk.
# Hệ cũ giữ /media/ramdisk/live riêng — VTCAIO dùng /media/ramdisk/vtcaio
# để chạy song song lâu dài (mỗi hệ 4G tmpfs riêng).
# Usage: sudo ./mount-ramdisk.sh
set -e
sudo mkdir -p /media/ramdisk/vtcaio
if mount | grep -q " /media/ramdisk/vtcaio .*tmpfs"; then
  echo "Already mounted at /media/ramdisk/vtcaio"
else
  sudo mount -t tmpfs -o size=4G tmpfs /media/ramdisk/vtcaio
  echo "Mounted tmpfs 4G at /media/ramdisk/vtcaio"
fi
df -h /media/ramdisk/vtcaio
