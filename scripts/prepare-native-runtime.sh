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

mkdir -p "$(dirname "${TARGET}")" "${TMP_DIR}"

if [ ! -x "${TARGET}" ]; then
  rm -rf "${TMP_DIR:?}/"*
  echo "Downloading Node.js ${NODE_VERSION} runtime for fnOS ${ARCH_LABEL}..."
  curl -fsSL "${URL}" -o "${TMP_DIR}/${ARCHIVE}"
  tar -xJf "${TMP_DIR}/${ARCHIVE}" -C "${TMP_DIR}"
  cp "${TMP_DIR}/node-v${NODE_VERSION}-linux-${TARGET_ARCH}/bin/node" "${TARGET}"
  chmod +x "${TARGET}"
fi

# Install ffmpeg for live stream transcoding
echo "Installing ffmpeg for live stream support..."
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
  echo "Warning: Could not auto-install ffmpeg. Please install ffmpeg manually."
  echo "On Debian/Ubuntu: apt-get install ffmpeg"
  echo "On Alpine: apk add ffmpeg"
  echo "On RHEL/CentOS: yum install ffmpeg"
fi

# Check ffmpeg availability and show encoder info
if command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg version: $(ffmpeg -version | head -n1)"
  echo "Available video encoders:"
  ffmpeg -hide_banner -encoders | grep -E "h264_(v4l2m2m|omx|vaapi)" || echo "No hardware encoders found, will use libx264 (software)"
else
  echo "Error: ffmpeg not found after installation attempt"
fi

rm -rf "${TMP_DIR}"
