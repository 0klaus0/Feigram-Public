const fs = require("fs-extra");
const path = require("path");
const { dataDir, downloadTasksPath, silentCachePath } = require("./store");

const metaPath = path.join(dataDir, "app-meta.json");

async function migrateStore() {
  await fs.ensureDir(dataDir);
  if (!(await fs.pathExists(downloadTasksPath))) {
    await fs.writeJson(downloadTasksPath, { tasks: [] }, { spaces: 2 });
  }
  if (!(await fs.pathExists(silentCachePath))) {
    await fs.writeJson(silentCachePath, { tasks: [] }, { spaces: 2 });
  }
  const current = await fs.readJson(metaPath).catch(() => ({}));
  const next = {
    ...current,
    edition: process.env.APP_EDITION || "Feigram 2.0 fnOS Client Edition",
    version: process.env.APP_VERSION || "dev",
    migratedAt: new Date().toISOString()
  };
  await fs.writeJson(metaPath, next, { spaces: 2 });
  return next;
}

module.exports = {
  migrateStore,
  metaPath
};
