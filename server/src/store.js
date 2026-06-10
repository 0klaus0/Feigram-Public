const crypto = require("crypto");
const fs = require("fs-extra");
const path = require("path");

const dataDir = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const accountsPath = path.join(dataDir, "accounts.json");
const secretPath = path.join(dataDir, "app-secret");
const usersPath = path.join(dataDir, "users.json");

async function ensureStore() {
  await fs.ensureDir(dataDir);
  await fs.ensureDir(process.env.DOWNLOAD_DIR || path.join(dataDir, "downloads"));
  if (!(await fs.pathExists(accountsPath))) {
    await fs.writeJson(accountsPath, { accounts: [] }, { spaces: 2 });
  }
  if (!(await fs.pathExists(usersPath))) {
    await fs.writeJson(usersPath, { users: [] }, { spaces: 2 });
  }
  if (!(await fs.pathExists(secretPath))) {
    await fs.writeFile(secretPath, crypto.randomBytes(32).toString("hex"), "utf8");
  }
}

async function getSecret() {
  await ensureStore();
  return (await fs.readFile(secretPath, "utf8")).trim();
}

async function readAccounts() {
  await ensureStore();
  const data = await fs.readJson(accountsPath);
  return data.accounts || [];
}

async function writeAccounts(accounts) {
  await ensureStore();
  await fs.writeJson(accountsPath, { accounts }, { spaces: 2 });
}

async function readUsers() {
  await ensureStore();
  const data = await fs.readJson(usersPath);
  return data.users || [];
}

async function writeUsers(users) {
  await ensureStore();
  await fs.writeJson(usersPath, { users }, { spaces: 2 });
}

async function upsertUser(user) {
  const users = await readUsers();
  const idx = users.findIndex((item) => item.id === user.id);
  if (idx >= 0) users[idx] = { ...users[idx], ...user };
  else users.push(user);
  await writeUsers(users);
  return user;
}

async function findUserByUsername(username) {
  const normalized = String(username || "").trim().toLowerCase();
  return (await readUsers()).find((user) => user.username.toLowerCase() === normalized);
}

async function upsertAccount(account) {
  const accounts = await readAccounts();
  const idx = accounts.findIndex((item) => item.id === account.id);
  if (idx >= 0) {
    accounts[idx] = { ...accounts[idx], ...account };
  } else {
    accounts.push(account);
  }
  await writeAccounts(accounts);
  return account;
}

async function removeAccount(accountId) {
  const accounts = await readAccounts();
  await writeAccounts(accounts.filter((item) => item.id !== accountId));
}

function safeId(prefix = "id") {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

module.exports = {
  dataDir,
  ensureStore,
  getSecret,
  findUserByUsername,
  readAccounts,
  readUsers,
  removeAccount,
  safeId,
  upsertAccount,
  upsertUser,
  writeUsers
};
