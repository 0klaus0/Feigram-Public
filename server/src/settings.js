const fs = require("fs-extra");
const path = require("path");
const { dataDir, ensureStore } = require("./store");
const { bundledTelegramApi } = require("./bundledTelegramApi");

const settingsPath = path.join(dataDir, "settings.json");

function envDefaults() {
  const dataRoot = process.env.DATA_DIR || "/data";
  const bundled = bundledTelegramApi();
  return {
    appPassword: process.env.APP_PASSWORD || "",
    publicBaseUrl: process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${process.env.APP_PORT || 3088}`,
    telegramApiId: process.env.TELEGRAM_API_ID || bundled.telegramApiId,
    telegramApiHash: process.env.TELEGRAM_API_HASH || bundled.telegramApiHash,
    cacheBaseDir: process.env.CACHE_BASE_DIR || process.env.DOWNLOAD_DIR || `${dataRoot}/downloads`,
    imageCacheDir: process.env.IMAGE_CACHE_DIR || "",
    videoCacheDir: process.env.VIDEO_CACHE_DIR || "",
    fileCacheDir: process.env.FILE_CACHE_DIR || "",
    cacheRetentionDays: process.env.CACHE_RETENTION_DAYS || "30"
  };
}

function sanitize(input = {}) {
  const retention = Math.max(1, Math.min(3650, Number(input.cacheRetentionDays || 30)));
  return {
    appPassword: String(input.appPassword ?? "").trim(),
    publicBaseUrl: String(input.publicBaseUrl ?? "").trim(),
    telegramApiId: String(input.telegramApiId ?? "").trim(),
    telegramApiHash: String(input.telegramApiHash ?? "").trim(),
    cacheBaseDir: String(input.cacheBaseDir ?? "").trim(),
    imageCacheDir: String(input.imageCacheDir ?? "").trim(),
    videoCacheDir: String(input.videoCacheDir ?? "").trim(),
    fileCacheDir: String(input.fileCacheDir ?? "").trim(),
    cacheRetentionDays: String(Number.isFinite(retention) ? retention : 30)
  };
}

async function readSettings() {
  await ensureStore();
  if (!(await fs.pathExists(settingsPath))) {
    return envDefaults();
  }
  const saved = await fs.readJson(settingsPath);
  return sanitize({ ...envDefaults(), ...saved });
}

async function writeSettings(input) {
  await ensureStore();
  const current = await readSettings();
  const next = sanitize({ ...current, ...input });
  await fs.writeJson(settingsPath, next, { spaces: 2 });
  return next;
}

async function settingsFileExists() {
  await ensureStore();
  return fs.pathExists(settingsPath);
}

function publicSettings(settings) {
  return {
    appPasswordSet: Boolean(settings.appPassword),
    publicBaseUrl: settings.publicBaseUrl,
    telegramApiId: "",
    telegramApiIdSet: Boolean(settings.telegramApiId),
    telegramApiHashSet: Boolean(settings.telegramApiHash && !settings.telegramApiHash.includes("put-your")),
    cacheBaseDir: settings.cacheBaseDir,
    imageCacheDir: settings.imageCacheDir,
    videoCacheDir: settings.videoCacheDir,
    fileCacheDir: settings.fileCacheDir,
    cacheRetentionDays: settings.cacheRetentionDays
  };
}

module.exports = {
  publicSettings,
  readSettings,
  settingsFileExists,
  writeSettings
};
