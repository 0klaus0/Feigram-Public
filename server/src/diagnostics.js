const fs = require("fs-extra");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { dataDir, downloadTasksPath, silentCachePath } = require("./store");
const { metaPath } = require("./migrations");
const { readSettings } = require("./settings");

async function dirSize(target) {
  let total = 0;
  const entries = await fs.readdir(target).catch(() => []);
  for (const entry of entries) {
    const filePath = path.join(target, entry);
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat) continue;
    if (stat.isDirectory()) total += await dirSize(filePath);
    else total += stat.size;
  }
  return total;
}

async function tail(filePath, maxBytes = 16000) {
  if (!filePath || !(await fs.pathExists(filePath))) return "";
  const stat = await fs.stat(filePath);
  const start = Math.max(0, stat.size - maxBytes);
  const handle = await fsp.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(stat.size - start);
    await handle.read(buffer, 0, buffer.length, start);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

async function diagnostics() {
  const settings = await readSettings();
  const [downloadData, silentData, meta] = await Promise.all([
    fs.readJson(downloadTasksPath).catch(() => ({ tasks: [] })),
    fs.readJson(silentCachePath).catch(() => ({ tasks: [] })),
    fs.readJson(metaPath).catch(() => ({}))
  ]);
  const cacheBase = settings.cacheBaseDir || process.env.DOWNLOAD_DIR || path.join(dataDir, "downloads");
  return {
    app: {
      name: "Feigram",
      edition: process.env.APP_EDITION || meta.edition || "Feigram 2.0 fnOS Client Edition",
      version: process.env.APP_VERSION || meta.version || "dev",
      changelog: process.env.APP_CHANGELOG || "",
      uptime: Math.round(process.uptime()),
      pid: process.pid,
      node: process.version,
      platform: `${os.platform()} ${os.arch()}`
    },
    paths: {
      dataDir,
      cacheBase,
      logFile: process.env.LOG_FILE || ""
    },
    downloader: { ok: true, engine: "gramjs", version: "GramJS 2.26.21" },
    cache: {
      bytes: await dirSize(cacheBase),
      downloadTasks: (downloadData.tasks || []).length,
      silentCacheTasks: (silentData.tasks || []).length
    },
    logTail: await tail(process.env.LOG_FILE)
  };
}

async function checkForUpdates() {
  const current = process.env.APP_VERSION || "dev";
  const endpoint = "https://api.github.com/repos/g-star1024/Feigram-Public/releases/latest";
  try {
    const response = await fetch(endpoint, { headers: { "User-Agent": "Feigram" } });
    if (!response.ok) throw new Error(`GitHub ${response.status}`);
    const latest = await response.json();
    const latestVersion = String(latest.tag_name || latest.name || "").replace(/^v/i, "");
    return {
      current,
      latest: latestVersion,
      url: latest.html_url || "https://github.com/g-star1024/Feigram-Public/releases",
      updateAvailable: Boolean(latestVersion && latestVersion !== current)
    };
  } catch (error) {
    return {
      current,
      latest: "",
      url: "https://github.com/g-star1024/Feigram-Public/releases",
      updateAvailable: false,
      error: error.message
    };
  }
}

module.exports = {
  checkForUpdates,
  diagnostics
};
