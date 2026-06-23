#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${VERSION:-2.0.68}"
PKG_NAME="feigrampub-${VERSION}"
RELEASE_DIR="${ROOT_DIR}/release"
WORK_DIR="${RELEASE_DIR}/${PKG_NAME}"
PACKAGE_SRC="${ROOT_DIR}/fnos-native-package"

"${ROOT_DIR}/scripts/prepare-native-runtime.sh"
"${ROOT_DIR}/scripts/prepare-go-downloader.sh"
npm --prefix "${ROOT_DIR}/client" run build
rm -rf "${ROOT_DIR}/server/public"
cp -R "${ROOT_DIR}/client/dist" "${ROOT_DIR}/server/public"

rm -rf "${WORK_DIR}" "${RELEASE_DIR}/${PKG_NAME}.fpk"
mkdir -p "${WORK_DIR}"
cp -R "${PACKAGE_SRC}/." "${WORK_DIR}/"
rm -rf "${WORK_DIR}/app/server"
mkdir -p "${WORK_DIR}/app/server"
cp "${ROOT_DIR}/server/package.json" "${ROOT_DIR}/server/package-lock.json" "${WORK_DIR}/app/server/"
cp -R "${ROOT_DIR}/server/src" "${ROOT_DIR}/server/public" "${WORK_DIR}/app/server/"
npm --prefix "${WORK_DIR}/app/server" ci --omit=dev

find "${WORK_DIR}" -name ".DS_Store" -delete
find "${WORK_DIR}/cmd" -type f -exec chmod +x {} \;
chmod +x "${WORK_DIR}/app/ui/proxy.cgi" "${WORK_DIR}/app/bin/node" "${WORK_DIR}/app/bin/feigram-downloader"

(
  cd "${WORK_DIR}"
  mkdir -p app_payload
  cp -R app/server app_payload/server
  cp -R app/bin app_payload/bin
  cp -R app/ui app_payload/ui
  cp -R config app_payload/config
  tar -czf app.tgz -C app_payload server bin ui config
  rm -rf app app_payload
  tar -czf "${RELEASE_DIR}/${PKG_NAME}.fpk" *
)

ls -lh "${RELEASE_DIR}/${PKG_NAME}.fpk"
