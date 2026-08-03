const fs = require("fs-extra");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { pipeline } = require("stream/promises");
const { createWriteStream } = require("fs");
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
      name: "Fngram",
      edition: process.env.APP_EDITION || meta.edition || "Fngram 2.0 fnOS Client Edition",
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
  const endpoint = "https://api.github.com/repos/0klaus0/fngram/releases/latest";
  try {
    const response = await fetch(endpoint, {
      headers: {
        "User-Agent": "Fngram",
        "Accept": "application/vnd.github+json"
      }
    });
    if (!response.ok) throw new Error(`GitHub ${response.status}`);
    const latest = await response.json();
    const latestVersion = String(latest.tag_name || latest.name || "").replace(/^v/i, "");
    const fpkAsset = (latest.assets || []).find((a) => String(a.name).endsWith(".fpk"));
    return {
      current,
      latest: latestVersion,
      url: latest.html_url || "https://github.com/0klaus0/fngram/releases",
      updateAvailable: Boolean(latestVersion && latestVersion !== current),
      fpkDownloadUrl: fpkAsset?.browser_download_url || null,
      fpkName: fpkAsset?.name || null,
      fpkSize: fpkAsset?.size || 0,
      releaseNotes: latest.body || ""
    };
  } catch (error) {
    // Fallback: try parsing the releases HTML page for the latest version
    try {
      const htmlResponse = await fetch("https://github.com/0klaus0/fngram/releases/latest", {
        headers: { "User-Agent": "Fngram" },
        redirect: "follow"
      });
      if (htmlResponse.ok) {
        const finalUrl = htmlResponse.url || "";
        const versionMatch = finalUrl.match(/\/releases\/tag\/v?([\d.]+)/);
        const latestVersion = versionMatch ? versionMatch[1] : "";
        if (latestVersion) {
          return {
            current,
            latest: latestVersion,
            url: finalUrl,
            updateAvailable: Boolean(latestVersion && latestVersion !== current),
            fpkDownloadUrl: null,
            fpkName: null,
            fpkSize: 0,
            releaseNotes: "",
            note: "API 受限，仅检测到版本号。请手动下载。"
          };
        }
      }
    } catch {
      // ignore fallback errors
    }
    return {
      current,
      latest: "",
      url: "https://github.com/0klaus0/fngram/releases",
      updateAvailable: false,
      error: error.message
    };
  }
}

async function downloadUpdate(onProgress) {
  const updateInfo = await checkForUpdates();
  if (!updateInfo.fpkDownloadUrl) {
    throw new Error("最新 Release 中未找到 FPK 安装包");
  }
  const updateDir = path.join(dataDir, "updates");
  await fs.ensureDir(updateDir);
  const filePath = path.join(updateDir, updateInfo.fpkName);
  const response = await fetch(updateInfo.fpkDownloadUrl, { headers: { "User-Agent": "Fngram" } });
  if (!response.ok) throw new Error(`下载失败: HTTP ${response.status}`);
  const total = Number(response.headers.get("content-length") || updateInfo.fpkSize || 0);
  let downloaded = 0;
  const writer = createWriteStream(filePath);
  const reader = response.body.getReader();
  let lastReport = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    await new Promise((resolve, reject) => {
      writer.write(value, (err) => err ? reject(err) : resolve());
    });
    downloaded += value.length;
    const now = Date.now();
    if (onProgress && (now - lastReport > 500 || downloaded === total)) {
      lastReport = now;
      onProgress({ downloaded, total, percent: total ? Math.round((downloaded / total) * 100) : 0 });
    }
  }
  await new Promise((resolve, reject) => writer.end(resolve));
  return { filePath, version: updateInfo.latest, size: downloaded };
}

module.exports = {
  checkForUpdates,
  downloadUpdate,
  diagnostics
};
