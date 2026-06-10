#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_VERSION="${NODE_VERSION:-22.11.0}"
TARGET="${ROOT_DIR}/fnos-native-package/app/bin/node"
FFMPEG_TARGET="${ROOT_DIR}/fnos-native-package/app/bin/ffmpeg"
FFPROBE_TARGET="${ROOT_DIR}/fnos-native-package/app/bin/ffprobe"
TMP_DIR="${ROOT_DIR}/release/node-runtime"
ARCHIVE="node-v${NODE_VERSION}-linux-x64.tar.xz"
URL="https://nodejs.org/dist/v${NODE_VERSION}/${ARCHIVE}"
FFMPEG_ARCHIVE="ffmpeg-release-amd64-static.tar.xz"
FFMPEG_URL="https://johnvansickle.com/ffmpeg/releases/${FFMPEG_ARCHIVE}"

mkdir -p "$(dirname "${TARGET}")" "${TMP_DIR}"

if [ ! -x "${TARGET}" ]; then
  rm -rf "${TMP_DIR:?}/"*
  echo "Downloading Node.js ${NODE_VERSION} runtime for fnOS x86_64..."
  curl -fsSL "${URL}" -o "${TMP_DIR}/${ARCHIVE}"
  tar -xJf "${TMP_DIR}/${ARCHIVE}" -C "${TMP_DIR}"
  cp "${TMP_DIR}/node-v${NODE_VERSION}-linux-x64/bin/node" "${TARGET}"
  chmod +x "${TARGET}"
fi

if [ ! -x "${FFMPEG_TARGET}" ] || [ ! -x "${FFPROBE_TARGET}" ]; then
  rm -rf "${TMP_DIR:?}/"*
  echo "Downloading static ffmpeg runtime for fnOS x86_64..."
  curl -fsSL "${FFMPEG_URL}" -o "${TMP_DIR}/${FFMPEG_ARCHIVE}"
  tar -xJf "${TMP_DIR}/${FFMPEG_ARCHIVE}" -C "${TMP_DIR}"
  FFMPEG_DIR="$(find "${TMP_DIR}" -maxdepth 1 -type d -name 'ffmpeg-*-amd64-static' | head -n 1)"
  cp "${FFMPEG_DIR}/ffmpeg" "${FFMPEG_TARGET}"
  cp "${FFMPEG_DIR}/ffprobe" "${FFPROBE_TARGET}"
  chmod +x "${FFMPEG_TARGET}" "${FFPROBE_TARGET}"
fi

rm -rf "${TMP_DIR}"
