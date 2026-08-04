#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_VERSION="${NODE_VERSION:-22.11.0}"
TARGET_ARCH="${TARGET_ARCH:-arm64}"
TARGET="${ROOT_DIR}/fnos-native-package/app/bin/node"
TMP_DIR="${ROOT_DIR}/release/node-runtime"

if [ "${TARGET_ARCH}" = "arm64" ]; then
  ARCHIVE="node-v${NODE_VERSION}-linux-arm64.tar.xz"
  ARCH_LABEL="arm64"
else
  ARCHIVE="node-v${NODE_VERSION}-linux-x64.tar.xz"
  ARCH_LABEL="x86_64"
fi

URL="https://nodejs.org/dist/v${NODE_VERSION}/${ARCHIVE}"
# 备用下载源
MIRROR_URL="https://npmmirror.com/mirrors/node/v${NODE_VERSION}/${ARCHIVE}"

mkdir -p "$(dirname "${TARGET}")" "${TMP_DIR}"

if [ ! -x "${TARGET}" ]; then
  rm -rf "${TMP_DIR:?}/"*
  echo "Downloading Node.js ${NODE_VERSION} runtime for fnOS ${ARCH_LABEL}..."
  
  # 使用带重试的下载函数
  download_with_retry() {
    local url=$1
    local output=$2
    local max_retries=3
    local retry=0
    
    while [ $retry -lt $max_retries ]; do
      echo "Downloading from: $url (attempt $((retry + 1))/$max_retries)"
      if curl -fL --connect-timeout 30 --max-time 120 --retry 2 --retry-delay 5 -o "$output" "$url" 2>&1; then
        echo "Download successful"
        return 0
      fi
      echo "Download failed, retrying in 5 seconds..."
      sleep 5
      retry=$((retry + 1))
    done
    return 1
  }
  
  # 先尝试官方源
  if ! download_with_retry "$URL" "${TMP_DIR}/${ARCHIVE}"; then
    echo "Official source failed, trying mirror..."
    if ! download_with_retry "$MIRROR_URL" "${TMP_DIR}/${ARCHIVE}"; then
      echo "Error: Failed to download Node.js from both sources"
      exit 1
    fi
  fi
  
  echo "Extracting Node.js..."
  tar -xJf "${TMP_DIR}/${ARCHIVE}" -C "${TMP_DIR}"
  cp "${TMP_DIR}/node-v${NODE_VERSION}-linux-${TARGET_ARCH}/bin/node" "${TARGET}"
  chmod +x "${TARGET}"
fi

# Install ffmpeg for live stream transcoding (only if root or ffmpeg not available)
echo "Checking ffmpeg for live stream support..."
if command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg already available: $(ffmpeg -version | head -n1)"
else
  echo "ffmpeg not found, attempting to install..."
  if [ "$(id -u)" -eq 0 ]; then
    if command -v apt-get >/dev/null 2>&1; then
      # Debian/Ubuntu based systems (including fnOS)
      apt-get update >/dev/null 2>&1
      apt-get install -y ffmpeg >/dev/null 2>&1
      echo "ffmpeg installed successfully"
    elif command -v apk >/dev/null 2>&1; then
      # Alpine Linux
      apk add --no-cache ffmpeg >/dev/null 2>&1
      echo "ffmpeg installed successfully"
    elif command -v yum >/dev/null 2>&1; then
      # RHEL/CentOS/Fedora
      yum install -y ffmpeg >/dev/null 2>&1
      echo "ffmpeg installed successfully"
    else
      echo "Warning: Could not auto-install ffmpeg (unsupported package manager)."
    fi
  else
    echo "Warning: Not running as root, skipping ffmpeg installation."
    echo "Please install ffmpeg manually on the target device:"
    echo "  Debian/Ubuntu: apt-get install ffmpeg"
    echo "  Alpine: apk add ffmpeg"
    echo "  RHEL/CentOS: yum install ffmpeg"
  fi
fi

# Check ffmpeg availability and show encoder info
if command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg version: $(ffmpeg -version | head -n1)"
  echo "Available video encoders:"
  ffmpeg -hide_banner -encoders | grep -E "h264_(v4l2m2m|omx|vaapi)" || echo "No hardware encoders found, will use libx264 (software)"
else
  echo "Warning: ffmpeg not available. Live streaming will not work without ffmpeg."
  echo "Please ensure ffmpeg is installed on the target fnOS device."
fi

rm -rf "${TMP_DIR}"
