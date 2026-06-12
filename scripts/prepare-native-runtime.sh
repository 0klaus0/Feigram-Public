#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_VERSION="${NODE_VERSION:-22.11.0}"
TARGET="${ROOT_DIR}/fnos-native-package/app/bin/node"
TMP_DIR="${ROOT_DIR}/release/node-runtime"
ARCHIVE="node-v${NODE_VERSION}-linux-x64.tar.xz"
URL="https://nodejs.org/dist/v${NODE_VERSION}/${ARCHIVE}"

mkdir -p "$(dirname "${TARGET}")" "${TMP_DIR}"

if [ ! -x "${TARGET}" ]; then
  rm -rf "${TMP_DIR:?}/"*
  echo "Downloading Node.js ${NODE_VERSION} runtime for fnOS x86_64..."
  curl -fsSL "${URL}" -o "${TMP_DIR}/${ARCHIVE}"
  tar -xJf "${TMP_DIR}/${ARCHIVE}" -C "${TMP_DIR}"
  cp "${TMP_DIR}/node-v${NODE_VERSION}-linux-x64/bin/node" "${TARGET}"
  chmod +x "${TARGET}"
fi

rm -rf "${TMP_DIR}"
