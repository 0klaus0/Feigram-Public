#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${VERSION:-0.1.1}"
PKG_NAME="feigram-${VERSION}"
RELEASE_DIR="${ROOT_DIR}/release"
WORK_DIR="${RELEASE_DIR}/${PKG_NAME}"
PACKAGE_SRC="${ROOT_DIR}/fnos-package"

rm -rf "${RELEASE_DIR}"
mkdir -p "${WORK_DIR}"

cp -R "${PACKAGE_SRC}/." "${WORK_DIR}/"

find "${WORK_DIR}" -name ".DS_Store" -delete
find "${WORK_DIR}/cmd" -type f -exec chmod +x {} \;
chmod +x "${WORK_DIR}/app/ui/proxy.cgi"

(
  cd "${WORK_DIR}"
  mkdir -p app_payload
  cp -R app/docker app_payload/docker
  cp -R app/ui app_payload/ui
  cp -R config app_payload/config
  tar -czf app.tgz -C app_payload docker ui config
  rm -rf app app_payload
  tar -czf "${RELEASE_DIR}/${PKG_NAME}.fpk" *
)

ls -lh "${RELEASE_DIR}/${PKG_NAME}.fpk"
