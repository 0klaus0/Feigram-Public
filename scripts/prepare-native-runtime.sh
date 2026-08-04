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

# 官方源 + 鏡像源
URLS=(
  "https://nodejs.org/dist/v${NODE_VERSION}/${ARCHIVE}"
  "https://npmmirror.com/mirrors/node/v${NODE_VERSION}/${ARCHIVE}"
  "https://mirrors.tuna.tsinghua.edu.cn/nodejs-release/v${NODE_VERSION}/${ARCHIVE}"
)

mkdir -p "$(dirname "${TARGET}")" "${TMP_DIR}"

if [ ! -x "${TARGET}" ]; then
  rm -rf "${TMP_DIR:?}/"*
  echo "Downloading Node.js ${NODE_VERSION} for ${ARCH_LABEL}..."

  download_with_retry() {
    local urls=("$@")
    local output="${TMP_DIR}/${ARCHIVE}"
    local max_retries=3

    for url in "${urls[@]}"; do
      for attempt in 1 2 3; do
        echo "Downloading: ${url} (attempt ${attempt}/3)"
        if curl -fL --connect-timeout 30 --max-time 180 --retry 2 --retry-delay 5 -o "${output}" "${url}" 2>&1; then
          if [ -s "${output}" ]; then
            echo "Download successful from: ${url}"
            return 0
          else
            echo "Downloaded file is empty, retrying..."
          fi
        fi
        echo "Attempt ${attempt} failed for ${url}, waiting 5s..."
        sleep 5
      done
    done
    echo "All download sources exhausted"
    return 1
  }

  if ! download_with_retry "${URLS[@]}"; then
    echo "ERROR: All download sources failed"
    exit 1
  fi

  echo "Extracting Node.js..."
  tar -xJf "${TMP_DIR}/${ARCHIVE}" -C "${TMP_DIR}"
  cp "${TMP_DIR}/node-v${NODE_VERSION}-linux-${TARGET_ARCH}/bin/node" "${TARGET}"
  chmod +x "${TARGET}"
  echo "Node.js binary installed: ${TARGET}"
fi

# Check ffmpeg
if command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg: $(ffmpeg -version | head -n1)"
  ffmpeg -hide_banner -encoders | grep -E "h264_(v4l2m2m|omx|vaapi)" || echo "No HW encoders, using libx264"
else
  echo "WARNING: ffmpeg not found"
fi

rm -rf "${TMP_DIR}"
echo "=== prepare-native-runtime.sh completed ==="