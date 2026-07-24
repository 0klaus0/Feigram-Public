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

rm -rf "${TMP_DIR}"
