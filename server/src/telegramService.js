const path = require("path");
const crypto = require("crypto");
const fs = require("fs-extra");
const mime = require("mime-types");
const bigInt = require("big-integer");
const { Api, TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const { dataDir, downloadTasksPath, readAccounts, removeAccount, safeId, silentCachePath, upsertAccount } = require("./store");
const { readSettings } = require("./settings");
const { decryptText, encryptText } = require("./cryptoBox");

const clients = new Map();
const cacheClients = new Map();
const peerCache = new Map();
const pendingLogins = new Map();
const downloadTasks = new Map();
const silentCacheRecords = new Map();
const silentCacheTasks = new Map();
const silentCacheQueue = [];
let silentCacheActive = 0;
let downloadPersistTimer = null;
let silentPersistTimer = null;
let realtimeIo = null;
let silentCacheEnabled = true;
let silentCacheRateLimitBps = 0;
let silentCacheConcurrency = 1;
let silentRateWindowStart = Date.now();
let silentRateWindowBytes = 0;
let silentRateChain = Promise.resolve();
const VIDEO_CACHE_THRESHOLD = 100 * 1024 * 1024;
const MAX_SILENT_CACHE_CONCURRENCY = 10;
const TELEGRAM_MIN_CHUNK_SIZE = 4096;
const MAX_TELEGRAM_CHUNK_SIZE = 512 * 1024;
const DOWNLOAD_RETRY_LIMIT = 3;
const SILENT_RETRY_DELAY_MS = 60 * 1000;
const STALE_TASK_MS = 90 * 1000;
const IDLE_SPEED_RESET_MS = 20 * 1000;
const DIALOG_FETCH_LIMIT = 500;

function stableId(prefix, ...parts) {
  return `${prefix}_${crypto.createHash("sha1").update(parts.map((part) => String(part ?? "")).join("|")).digest("hex").slice(0, 24)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientDownloadError(error) {
  const message = String(error?.message || error || "");
  return /FILE_REFERENCE_EXPIRED|File reference expired|Request was unsuccessful|TIMEOUT|timeout|ECONN|ETIMEDOUT|EPIPE|socket|network|disconnect|CONNECTION_NOT_INITED|AUTH_KEY_UNREGISTERED|AUTH_KEY_DUPLICATED|Not connected/i.test(message);
}

function isFileReferenceExpired(error) {
  return /FILE_REFERENCE_EXPIRED|File reference expired/i.test(String(error?.message || error || ""));
}

function nextSilentOrder() {
  return Math.max(0, ...[...silentCacheRecords.values()].map((task) => Number(task.order || 0))) + 1;
}

function enqueueSilentTask(task) {
  if (!task || ["completed", "cancelled"].includes(task.status)) return;
  if (silentCacheQueue.some((item) => item.id === task.id)) return;
  silentCacheQueue.push(task);
  silentCacheQueue.sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
}

function silentConcurrencyLimit() {
  return Math.max(1, Math.min(MAX_SILENT_CACHE_CONCURRENCY, Number(silentCacheConcurrency || 1)));
}

function resetSilentRateWindow() {
  silentRateWindowStart = Date.now();
  silentRateWindowBytes = 0;
  silentRateChain = Promise.resolve();
}

function rebalanceSilentConcurrency(io = realtimeIo) {
  const limit = silentConcurrencyLimit();
  const running = [...silentCacheRecords.values()]
    .filter((task) => task.status === "running" && task.cancelToken)
    .sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
  running.slice(limit).forEach((task) => {
    task.cancelToken.paused = true;
    task.cancelToken.requeue = true;
    task.status = "queued";
    task.speedBps = 0;
    task.updatedAt = new Date().toISOString();
    enqueueSilentTask(task);
    emitSilentCacheTask(io, task);
  });
}

async function throttleSilentCache(deltaBytes) {
  const delta = Math.max(0, Number(deltaBytes || 0));
  const rate = Number(silentCacheRateLimitBps || 0);
  if (!delta || !rate) return;
  silentRateChain = silentRateChain.catch(() => {}).then(async () => {
    const currentRate = Number(silentCacheRateLimitBps || 0);
    if (!currentRate) return;
    const now = Date.now();
    if (now - silentRateWindowStart > 60 * 1000) {
      silentRateWindowStart = now;
      silentRateWindowBytes = 0;
    }
    silentRateWindowBytes += delta;
    const expectedElapsed = (silentRateWindowBytes / currentRate) * 1000;
    const actualElapsed = Date.now() - silentRateWindowStart;
    if (expectedElapsed > actualElapsed) {
      await sleep(expectedElapsed - actualElapsed);
    }
  });
  return silentRateChain;
}

function schedulePersistDownloads() {
  if (downloadPersistTimer) return;
  downloadPersistTimer = setTimeout(async () => {
    downloadPersistTimer = null;
    await persistDownloadTasks().catch((error) => console.warn("Persist downloads failed:", error.message));
  }, 500);
  downloadPersistTimer.unref?.();
}

function schedulePersistSilent() {
  if (silentPersistTimer) return;
  silentPersistTimer = setTimeout(async () => {
    silentPersistTimer = null;
    await persistSilentCacheTasks().catch((error) => console.warn("Persist silent cache failed:", error.message));
  }, 500);
  silentPersistTimer.unref?.();
}

async function persistDownloadTasks() {
  await fs.ensureDir(dataDir);
  const tasks = [...downloadTasks.values()].map(({ cancelToken, ...task }) => task);
  await fs.writeJson(downloadTasksPath, { tasks }, { spaces: 2 });
}

async function persistSilentCacheTasks() {
  await fs.ensureDir(dataDir);
  const tasks = [...silentCacheRecords.values()].map(({ cancelToken, runToken, lastObservedPartSize, lastObservedAt, ...task }) => task);
  await fs.writeJson(silentCachePath, {
    enabled: silentCacheEnabled,
    rateLimitBps: silentCacheRateLimitBps,
    concurrency: silentConcurrencyLimit(),
    tasks
  }, { spaces: 2 });
}

async function loadPersistentTasks() {
  const savedDownloads = await fs.readJson(downloadTasksPath).catch(() => ({ tasks: [] }));
  for (const task of savedDownloads.tasks || []) {
    if (!task?.id || !task.userId || !task.accountId || !task.peerId || !task.messageId) continue;
    const completedFileExists = task.status === "completed" && task.filePath && await fs.pathExists(task.filePath);
    const next = {
      ...task,
      cancelToken: null,
      retryCount: Number(task.retryCount || 0),
      speedBps: 0,
      status: completedFileExists ? "completed" : "queued",
      updatedAt: new Date().toISOString()
    };
    downloadTasks.set(next.id, next);
  }

  const savedSilent = await fs.readJson(silentCachePath).catch(() => ({ tasks: [] }));
  silentCacheEnabled = savedSilent.enabled !== false;
  silentCacheRateLimitBps = Math.max(0, Number(savedSilent.rateLimitBps || 0));
  silentCacheConcurrency = Math.max(1, Math.min(MAX_SILENT_CACHE_CONCURRENCY, Number(savedSilent.concurrency || 1)));
  for (const task of savedSilent.tasks || []) {
    if (!task?.id || !task.userId || !task.accountId || !task.peerId || !task.messageId) continue;
    if (task.status === "cancelled") continue;
    const completedFileExists = task.status === "completed" && task.filePath && await fs.pathExists(task.filePath);
    const shouldResume = !["completed", "cancelled"].includes(task.status);
    const next = {
      ...task,
      cancelToken: null,
      order: Number(task.order || (task.createdAt ? Date.parse(task.createdAt) : 0) || nextSilentOrder()),
      retryCount: Number(task.retryCount || 0),
      lastProgressAt: task.lastProgressAt || task.updatedAt || new Date().toISOString(),
      speedBps: 0,
      status: completedFileExists ? "completed" : shouldResume ? "queued" : task.status,
      error: "",
      updatedAt: new Date().toISOString()
    };
    silentCacheRecords.set(next.id, next);
    if (next.status === "queued") enqueueSilentTask(next);
  }
}

async function restoreBackgroundTasks(io) {
  realtimeIo = io;
  await loadPersistentTasks();
  for (const task of downloadTasks.values()) {
    if (task.status !== "completed") {
      startDownloadTask(task.userId, task.accountId, task.peerId, task.messageId, io).catch((error) => {
        task.status = "error";
        task.error = error.message || "恢复下载失败";
        task.updatedAt = new Date().toISOString();
        emitDownloadTask(io, task);
      });
    }
  }
  pumpSilentCacheQueue(io);
}

async function cacheSettings() {
  const settings = await readSettings();
  const base = settings.cacheBaseDir || process.env.DOWNLOAD_DIR || path.join(process.env.DATA_DIR || "/data", "downloads");
  return {
    base,
    image: settings.imageCacheDir || path.join(base, "images"),
    video: settings.videoCacheDir || path.join(base, "videos"),
    file: settings.fileCacheDir || path.join(base, "files"),
    avatars: path.join(base, "avatars"),
    thumbs: path.join(base, "thumbs"),
    retentionDays: Math.max(1, Number(settings.cacheRetentionDays || 30))
  };
}

function safeName(value) {
  return String(value || "telegram-file").replace(/[\\/:*?"<>|]/g, "_").slice(0, 180);
}

function videoDimensions(message) {
  const attr = message.document?.attributes?.find?.((item) => (
    item.className === "DocumentAttributeVideo" || item.constructor?.name === "DocumentAttributeVideo"
  ));
  return {
    width: Number(attr?.w || 0),
    height: Number(attr?.h || 0),
    duration: Number(attr?.duration || 0)
  };
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(message), { status: 504 })), ms);
    })
  ]);
}

async function telegramConfig() {
  const settings = await readSettings();
  const apiId = Number(settings.telegramApiId || 0);
  const apiHash = settings.telegramApiHash || "";
  if (!apiId || !apiHash || apiHash.includes("put-your")) {
    const err = new Error("Telegram API 配置不可用，请在管理员后台覆盖 API 设置");
    err.status = 500;
    throw err;
  }
  return { apiId, apiHash };
}

function toText(value) {
  if (value === undefined || value === null) return "";
  return typeof value === "bigint" ? value.toString() : String(value);
}

function peerKey(entity) {
  const klass = entity.className || entity.constructor?.name || "Peer";
  return `${klass}:${toText(entity.id)}`;
}

function peerIdFromPeer(peer) {
  if (!peer) return "";
  const klass = peer.className || peer.constructor?.name || "";
  const id = peer.userId || peer.chatId || peer.channelId || peer.id;
  if (!id) return "";
  if (klass.includes("User")) return `User:${toText(id)}`;
  if (klass.includes("Channel")) return `Channel:${toText(id)}`;
  if (klass.includes("Chat")) return `Chat:${toText(id)}`;
  return "";
}

function peerFromId(peerId) {
  const [type, rawId] = String(peerId || "").split(":");
  if (!type || !rawId || !/^-?\d+$/.test(rawId)) return null;
  const id = bigInt(rawId);
  if (type === "User") return new Api.PeerUser({ userId: id });
  if (type === "Chat") return new Api.PeerChat({ chatId: id });
  if (type === "Channel") return new Api.PeerChannel({ channelId: id });
  return null;
}

function serializeEntity(entity) {
  const title = entity.title || [entity.firstName, entity.lastName].filter(Boolean).join(" ") || entity.username || "Unknown";
  return {
    id: peerKey(entity),
    rawId: toText(entity.id),
    title,
    username: entity.username || "",
    type: entity.broadcast ? "channel" : entity.megagroup || entity.gigagroup ? "group" : entity.className === "User" ? "private" : "chat"
  };
}

function serializeSender(entity, fallbackId = "") {
  if (!entity) {
    return {
      id: fallbackId,
      title: fallbackId || "Unknown",
      username: "",
      rawId: fallbackId
    };
  }
  const chat = serializeEntity(entity);
  return {
    id: chat.id,
    title: chat.title,
    username: chat.username,
    rawId: chat.rawId
  };
}

async function filterPeerToChat(client, peer) {
  const entity = await client.getEntity(peer).catch(() => null);
  if (!entity) return null;
  return serializeEntity(entity);
}

async function serializeDialogFilter(client, filter) {
  const id = Number(filter.id || 0);
  const title = filter.title?.text || filter.title || "";
  if (!id || !title) return null;
  const includePeers = await Promise.all((filter.includePeers || []).map((peer) => filterPeerToChat(client, peer)));
  const pinnedPeers = await Promise.all((filter.pinnedPeers || []).map((peer) => filterPeerToChat(client, peer)));
  const excludePeers = await Promise.all((filter.excludePeers || []).map((peer) => filterPeerToChat(client, peer)));
  return {
    id,
    title: String(title),
    emoticon: filter.emoticon || "",
    includePeerIds: includePeers.filter(Boolean).map((chat) => chat.id),
    pinnedPeerIds: pinnedPeers.filter(Boolean).map((chat) => chat.id),
    excludePeerIds: excludePeers.filter(Boolean).map((chat) => chat.id),
    flags: {
      contacts: Boolean(filter.contacts),
      nonContacts: Boolean(filter.nonContacts),
      groups: Boolean(filter.groups),
      broadcasts: Boolean(filter.broadcasts),
      bots: Boolean(filter.bots),
      excludeMuted: Boolean(filter.excludeMuted),
      excludeRead: Boolean(filter.excludeRead),
      excludeArchived: Boolean(filter.excludeArchived)
    }
  };
}

function serializeDialogFilterShallow(filter) {
  const id = Number(filter.id || 0);
  const title = filter.title?.text || filter.title || "";
  if (!id || !title) return null;
  const includePeerIds = (filter.includePeers || []).map(peerIdFromPeer).filter(Boolean);
  const pinnedPeerIds = (filter.pinnedPeers || []).map(peerIdFromPeer).filter(Boolean);
  const excludePeerIds = (filter.excludePeers || []).map(peerIdFromPeer).filter(Boolean);
  return {
    id,
    title: String(title),
    emoticon: filter.emoticon || "",
    includePeerIds,
    pinnedPeerIds,
    excludePeerIds,
    flags: {
      contacts: Boolean(filter.contacts),
      nonContacts: Boolean(filter.nonContacts),
      groups: Boolean(filter.groups),
      broadcasts: Boolean(filter.broadcasts),
      bots: Boolean(filter.bots),
      excludeMuted: Boolean(filter.excludeMuted),
      excludeRead: Boolean(filter.excludeRead),
      excludeArchived: Boolean(filter.excludeArchived)
    }
  };
}

function normalizeDialogFilters(result) {
  const filters = Array.isArray(result) ? result : result?.filters || [];
  return filters.filter((filter) => {
    const klass = filter.className || filter.constructor?.name || "";
    return klass !== "DialogFilterDefault";
  });
}

function dialogMuted(dialog) {
  const muteUntil = Number(dialog.notifySettings?.muteUntil || dialog.dialog?.notifySettings?.muteUntil || 0);
  return muteUntil > Math.floor(Date.now() / 1000);
}

function filterMatchesChat(filter, chat, dialog) {
  const include = new Set([...(filter.includePeerIds || []), ...(filter.pinnedPeerIds || [])]);
  const exclude = new Set(filter.excludePeerIds || []);
  const flags = filter.flags || {};
  if (exclude.has(chat.id)) return false;
  if (include.has(chat.id)) return true;
  if ((chat.folderIds || []).some((id) => String(id) === String(filter.id))) return true;
  if (flags.excludeArchived && chat.archived) return false;
  if (flags.excludeMuted && dialogMuted(dialog)) return false;
  if (flags.excludeRead && !chat.unreadCount) return false;
  const entity = dialog.entity || {};
  if (chat.type === "group" && flags.groups) return true;
  if (chat.type === "channel" && flags.broadcasts) return true;
  if (chat.type === "private" && entity.bot && flags.bots) return true;
  if (chat.type === "private" && entity.contact && flags.contacts) return true;
  if (chat.type === "private" && !entity.contact && !entity.bot && flags.nonContacts) return true;
  return false;
}

function messageText(message) {
  return message.message || "";
}

function mediaKind(message, mimeType = "") {
  if (message.photo) return "image";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/") || message.video) return "video";
  return "file";
}

function inputDocumentFileLocation(doc) {
  if (!doc) return null;
  return new Api.InputDocumentFileLocation({
    id: doc.id,
    accessHash: doc.accessHash,
    fileReference: doc.fileReference,
    thumbSize: ""
  });
}

function inputFileLocation(message) {
  if (message.document) return inputDocumentFileLocation(message.document);
  return message.photo || message.media;
}

function serializeMessageEntities(message) {
  const text = messageText(message);
  return (message.entities || []).map((entity) => {
    const type = entity.className || entity.constructor?.name || "";
    const offset = Number(entity.offset || 0);
    const length = Number(entity.length || 0);
    const value = text.slice(offset, offset + length);
    let url = "";
    if (entity.url) url = entity.url;
    else if (type === "MessageEntityUrl") url = value;
    else if (type === "MessageEntityMention" && value.startsWith("@")) url = `https://t.me/${value.slice(1)}`;
    else if (type === "MessageEntityMentionName" && entity.userId) url = `tg://user?id=${toText(entity.userId)}`;
    if (!url) return null;
    if (url.startsWith("t.me/")) url = `https://${url}`;
    return { offset, length, url, type };
  }).filter(Boolean);
}

function linkDomain(url) {
  const value = String(url || "").trim();
  if (!value) return "";
  if (value.startsWith("@")) return value.slice(1);
  if (value.startsWith("tg://resolve")) return new URL(value).searchParams.get("domain") || "";
  const normalized = value.startsWith("t.me/") ? `https://${value}` : value;
  try {
    const parsed = new URL(normalized);
    if (!["t.me", "telegram.me", "www.t.me", "www.telegram.me"].includes(parsed.hostname)) return "";
    const [domain] = parsed.pathname.split("/").filter(Boolean);
    if (!domain || domain === "c" || domain === "joinchat" || domain.startsWith("+")) return "";
    return domain;
  } catch {
    return "";
  }
}

function linkMessageId(url) {
  try {
    const value = String(url || "").trim();
    const normalized = value.startsWith("t.me/") ? `https://${value}` : value;
    const parsed = new URL(normalized);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const numeric = [...parts].reverse().find((part) => /^\d+$/.test(part));
    return numeric ? Number(numeric) : 0;
  } catch {
    return 0;
  }
}

function linkPrivatePeerId(url) {
  try {
    const value = String(url || "").trim();
    const normalized = value.startsWith("t.me/") ? `https://${value}` : value;
    const parsed = new URL(normalized);
    if (!["t.me", "telegram.me", "www.t.me", "www.telegram.me"].includes(parsed.hostname)) return "";
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts[0] !== "c" || !/^\d+$/.test(parts[1] || "")) return "";
    return `Channel:${parts[1]}`;
  } catch {
    return "";
  }
}

function serializeMessage(message) {
  const mimeType = message.document?.mimeType || "";
  const kind = mediaKind(message, mimeType);
  const media = message.media ? {
    className: message.media.className || message.media.constructor?.name || "Media",
    hasPreview: Boolean(message.photo || message.document),
    mimeType: kind === "image" && !mimeType ? "image/jpeg" : mimeType,
    kind,
    ...videoDimensions(message),
    fileName: message.file?.name || message.document?.attributes?.find?.((a) => a.fileName)?.fileName || "",
    size: toText(message.file?.size || message.document?.size || "")
  } : null;

  const buttons = message.replyMarkup?.rows?.map((row) => (
    row.buttons.map((button) => ({
      text: button.text || "",
      url: button.url || "",
      data: button.data ? Buffer.from(button.data).toString("base64") : "",
      type: button.url ? "url" : button.data ? "callback" : "unsupported"
    }))
  )).filter((row) => row.length) || [];

  return {
    id: message.id,
    date: message.date ? new Date(message.date * 1000).toISOString() : "",
    text: messageText(message),
    entities: serializeMessageEntities(message),
    outgoing: Boolean(message.out),
    senderId: toText(message.senderId),
    sender: serializeSender(message.sender, toText(message.senderId)),
    groupedId: toText(message.groupedId),
    buttons,
    media
  };
}

function serializeMediaResource(message) {
  const item = serializeMessage(message);
  return {
    id: item.id,
    date: item.date,
    text: item.text,
    fileName: item.media?.fileName || item.media?.mimeType || "Telegram 媒体",
    kind: item.media?.kind || "file",
    size: item.media?.size || "",
    width: item.media?.width || 0,
    height: item.media?.height || 0,
    duration: item.media?.duration || 0
  };
}

function rememberMessageSenders(accountId, messages) {
  if (!peerCache.has(accountId)) peerCache.set(accountId, new Map());
  const cache = peerCache.get(accountId);
  messages.forEach((message) => {
    if (message.sender) cache.set(peerKey(message.sender), message.sender);
  });
}

async function createClient(sessionString = "") {
  const { apiId, apiHash } = await telegramConfig();
  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 3
  });
  await withTimeout(client.connect(), 20000, "连接 Telegram 超时，请检查网络");
  return client;
}

async function loadSavedClients(io) {
  const accounts = await readAccounts();
  for (const account of accounts) {
    try {
      const client = await createClient(await decryptText(account.session));
      if (await client.checkAuthorization()) {
        clients.set(account.id, client);
        registerUpdates(io, account.id, client);
      }
    } catch (error) {
      console.warn(`Failed to connect account ${account.label}:`, error.message);
    }
  }
}

function registerUpdates(io, accountId, client) {
  if (client.__feigrameUpdatesRegistered) return;
  client.__feigrameUpdatesRegistered = true;
  client.addEventHandler((event) => {
    const message = event.message;
    if (!message) return;
    io.to(`account:${accountId}`).emit("message:new", {
      accountId,
      message: serializeMessage(message),
      peerId: message.chatId ? toText(message.chatId) : ""
    });
  }, new NewMessage({}));
}

async function listAccounts(userId) {
  const accounts = await readAccounts();
  return accounts.filter((account) => account.userId === userId).map(({ session, ...safe }) => ({
    ...safe,
    connected: clients.has(safe.id)
  }));
}

async function getClient(userId, accountId) {
  const existing = clients.get(accountId);
  if (existing) {
    try {
      if (existing.connected === false) await existing.connect();
      if (await existing.checkAuthorization()) return existing;
    } catch {}
    await resetTelegramClient(accountId);
  }
  const account = (await readAccounts()).find((item) => item.id === accountId && item.userId === userId);
  if (!account) throw Object.assign(new Error("账号不存在"), { status: 404 });
  const client = await createClient(await decryptText(account.session));
  if (!(await client.checkAuthorization())) throw Object.assign(new Error("账号登录已失效"), { status: 401 });
  clients.set(accountId, client);
  if (realtimeIo) registerUpdates(realtimeIo, accountId, client);
  return client;
}

async function getCacheClient(userId, accountId) {
  return getClient(userId, accountId);
}

async function resetCacheClient(accountId) {
  const client = cacheClients.get(accountId);
  if (client) {
    try {
      await client.disconnect();
    } catch {}
  }
  cacheClients.delete(accountId);
}

async function resetTelegramClient(accountId) {
  await resetCacheClient(accountId);
  const client = clients.get(accountId);
  if (client) {
    try {
      await client.disconnect();
    } catch {}
  }
  clients.delete(accountId);
}

async function startLogin(userId, { label, phoneNumber }) {
  const { apiId, apiHash } = await telegramConfig();
  const client = await createClient("");
  const sent = await withTimeout(
    client.sendCode({ apiId, apiHash }, phoneNumber),
    20000,
    "发送验证码超时，请检查 Telegram API 配置和网络"
  );
  const loginId = safeId("login");
  pendingLogins.set(loginId, {
    client,
    userId,
    label: label || phoneNumber,
    phoneNumber,
    phoneCodeHash: sent.phoneCodeHash
  });
  return { loginId, isCodeViaApp: sent.isCodeViaApp };
}

async function completeCode({ loginId, code }, io) {
  const pending = pendingLogins.get(loginId);
  if (!pending) throw Object.assign(new Error("登录流程已过期，请重新发送验证码"), { status: 400 });
  try {
    await pending.client.invoke(new Api.auth.SignIn({
      phoneNumber: pending.phoneNumber,
      phoneCodeHash: pending.phoneCodeHash,
      phoneCode: code
    }));
  } catch (error) {
    if (error.message && error.message.includes("SESSION_PASSWORD_NEEDED")) {
      return { passwordRequired: true };
    }
    throw error;
  }
  return saveLoggedInClient(loginId, io);
}

async function completePassword({ loginId, password }, io) {
  const pending = pendingLogins.get(loginId);
  if (!pending) throw Object.assign(new Error("登录流程已过期，请重新开始"), { status: 400 });
  const { apiId, apiHash } = await telegramConfig();
  await pending.client.signInWithPassword({ apiId, apiHash }, {
    password: async () => password,
    onError: (error) => {
      throw error;
    }
  });
  return saveLoggedInClient(loginId, io);
}

async function saveLoggedInClient(loginId, io) {
  const pending = pendingLogins.get(loginId);
  const me = await pending.client.getMe();
  const id = safeId("account");
  const account = {
    id,
    userId: pending.userId,
    label: pending.label,
    phoneNumber: pending.phoneNumber,
    displayName: [me.firstName, me.lastName].filter(Boolean).join(" ") || me.username || pending.label,
    username: me.username || "",
    rawUserId: toText(me.id),
    session: await encryptText(pending.client.session.save()),
    createdAt: new Date().toISOString()
  };
  await upsertAccount(account);
  clients.set(id, pending.client);
  registerUpdates(io, id, pending.client);
  pendingLogins.delete(loginId);
  return { account: { ...account, session: undefined, connected: true } };
}

async function logout(userId, accountId) {
  const client = clients.get(accountId);
  if (client) {
    try {
      await client.disconnect();
    } catch {}
  }
  clients.delete(accountId);
  await resetCacheClient(accountId);
  peerCache.delete(accountId);
  const account = (await readAccounts()).find((item) => item.id === accountId);
  if (!account || account.userId !== userId) throw Object.assign(new Error("账号不存在"), { status: 404 });
  await removeAccount(accountId);
}

async function listChats(userId, accountId, query = "") {
  const client = await getClient(userId, accountId);
  const dialogs = await client.getDialogs({ limit: DIALOG_FETCH_LIMIT });
  const accountPeers = new Map();
  const normalizedQuery = query.trim().toLowerCase();
  const items = dialogs
    .map((dialog) => {
      const entity = dialog.entity;
      const chat = serializeEntity(entity);
      accountPeers.set(chat.id, entity);
      return {
        ...chat,
        avatarKey: chat.id,
        folderId: Number(dialog.folderId || 0),
        folderIds: Number(dialog.folderId || 0) ? [Number(dialog.folderId)] : [],
        unreadCount: dialog.unreadCount || 0,
        pinned: Boolean(dialog.pinned),
        archived: Boolean(dialog.archived),
        lastMessage: dialog.message ? serializeMessage(dialog.message) : null
      };
    })
    .filter((chat) => !normalizedQuery || chat.title.toLowerCase().includes(normalizedQuery) || chat.username.toLowerCase().includes(normalizedQuery));
  peerCache.set(accountId, accountPeers);
  return items;
}

async function listFolders(userId, accountId) {
  const client = await getClient(userId, accountId);
  const [filterResult, dialogs] = await Promise.all([
    client.invoke(new Api.messages.GetDialogFilters()).catch(() => []),
    client.getDialogs({ limit: DIALOG_FETCH_LIMIT }).catch(() => [])
  ]);
  const accountPeers = new Map();
  const chatsById = new Map();
  const chatDialogs = [];
  dialogs.forEach((dialog) => {
    if (!dialog.entity) return;
    const chat = serializeEntity(dialog.entity);
    const folderId = Number(dialog.folderId || 0);
    const item = {
      ...chat,
      folderId,
      folderIds: folderId ? [folderId] : [],
      unreadCount: dialog.unreadCount || 0,
      pinned: Boolean(dialog.pinned),
      archived: Boolean(dialog.archived),
      lastMessage: dialog.message ? serializeMessage(dialog.message) : null
    };
    accountPeers.set(chat.id, dialog.entity);
    chatsById.set(chat.id, item);
    chatDialogs.push({ chat: item, dialog });
  });
  if (accountPeers.size) peerCache.set(accountId, accountPeers);

  const filters = normalizeDialogFilters(filterResult);
  const shallow = filters.map(serializeDialogFilterShallow).filter(Boolean).map((filter) => ({
    ...filter,
    chatIds: chatDialogs
      .filter(({ chat, dialog }) => filterMatchesChat(filter, chat, dialog))
      .map(({ chat }) => chat.id)
  })).filter((filter) => filter.chatIds.length || filter.includePeerIds.length || filter.pinnedPeerIds.length);
  if (shallow.length) {
    return shallow;
  }
  const folderIds = [...new Set(dialogs.map((dialog) => Number(dialog.folderId || 0)).filter(Boolean))];
  return folderIds.map((id) => ({
    id,
    title: id === 1 ? "归档" : `文件夹 ${id}`,
    emoticon: "",
    includePeerIds: [],
    pinnedPeerIds: [],
    excludePeerIds: [],
    flags: {},
    chatIds: [...chatsById.values()].filter((chat) => Number(chat.folderId || 0) === id).map((chat) => chat.id)
  }));
}

async function resolvePeer(userId, accountId, peerId) {
  const cached = peerCache.get(accountId)?.get(peerId);
  if (cached) return cached;

  const client = await getClient(userId, accountId);
  const directPeer = peerFromId(peerId);
  const directEntity = directPeer ? await client.getEntity(directPeer).catch(() => null) : null;
  if (directEntity) {
    if (!peerCache.has(accountId)) peerCache.set(accountId, new Map());
    peerCache.get(accountId).set(peerId, directEntity);
    return directEntity;
  }

  await listChats(userId, accountId);
  const listed = peerCache.get(accountId)?.get(peerId);
  if (listed) return listed;

  throw Object.assign(new Error("找不到会话，可能已退出该群组、会话已被删除，或 Telegram 暂时无法解析该会话"), { status: 404 });
}

async function listMessages(userId, accountId, peerId, limit = 50, before = 0, around = 0) {
  const client = await getClient(userId, accountId);
  const entity = await resolvePeer(userId, accountId, peerId);
  const request = { limit: Number(limit) || 50 };
  if (Number(around) > 0) {
    request.offsetId = Number(around);
    request.addOffset = -Math.floor(request.limit / 2);
  } else if (Number(before) > 0) {
    request.offsetId = Number(before);
  }
  const messages = await client.getMessages(entity, request);
  if (Number(around) > 0 && !messages.some((message) => Number(message.id) === Number(around))) {
    const [target] = await client.getMessages(entity, { ids: [Number(around)] }).catch(() => []);
    if (target) messages.push(target);
  }
  rememberMessageSenders(accountId, messages);
  return messages
    .map(serializeMessage)
    .sort((a, b) => Number(a.id) - Number(b.id));
}

async function chatDetails(userId, accountId, peerId) {
  const client = await getClient(userId, accountId);
  const entity = await resolvePeer(userId, accountId, peerId);
  const chat = serializeEntity(entity);
  let full = null;
  try {
    if (chat.type === "channel" || chat.type === "group") {
      full = await client.invoke(new Api.channels.GetFullChannel({ channel: entity }));
    } else if ((entity.className || entity.constructor?.name || "") === "Chat") {
      full = await client.invoke(new Api.messages.GetFullChat({ chatId: entity.id }));
    } else {
      full = await client.invoke(new Api.users.GetFullUser({ id: entity }));
    }
  } catch {}
  const fullChat = full?.fullChat || full?.fullUser || {};
  const mediaPage = await chatMedia(userId, accountId, peerId, { limit: 30 });
  const mediaMessages = mediaPage.files;
  return {
    ...chat,
    about: fullChat.about || "",
    participantsCount: Number(fullChat.participantsCount || fullChat.membersCount || entity.participantsCount || 0),
    mediaSummary: {
      images: mediaMessages.filter((message) => message.kind === "image").length,
      videos: mediaMessages.filter((message) => message.kind === "video").length,
      files: mediaMessages.filter((message) => message.kind === "file").length
    },
    files: mediaMessages,
    nextMediaBefore: mediaPage.nextBefore,
    hasMoreMedia: mediaPage.hasMore
  };
}

async function chatMedia(userId, accountId, peerId, { before = 0, limit = 30 } = {}) {
  const client = await getClient(userId, accountId);
  const entity = await resolvePeer(userId, accountId, peerId);
  const pageSize = Math.max(1, Math.min(60, Number(limit) || 30));
  const requestLimit = Math.min(200, pageSize * 4);
  const request = { limit: requestLimit };
  if (Number(before) > 0) request.offsetId = Number(before);
  const messages = await client.getMessages(entity, request).catch(() => []);
  const mediaMessages = messages.filter((message) => message.media);
  const page = mediaMessages.slice(0, pageSize);
  return {
    files: page.map(serializeMediaResource),
    nextBefore: page.length ? Math.min(...page.map((message) => Number(message.id))) : 0,
    hasMore: messages.length >= requestLimit
  };
}

async function sendText(userId, accountId, peerId, text) {
  const client = await getClient(userId, accountId);
  const entity = await resolvePeer(userId, accountId, peerId);
  const message = await client.sendMessage(entity, { message: text });
  rememberMessageSenders(accountId, [message]);
  return serializeMessage(message);
}

async function clickMessageButton(userId, accountId, peerId, messageId, data) {
  if (!data) throw Object.assign(new Error("这个按钮暂不支持点击"), { status: 400 });
  const client = await getClient(userId, accountId);
  const entity = await resolvePeer(userId, accountId, peerId);
  let answer;
  try {
    answer = await withTimeout(client.invoke(new Api.messages.GetBotCallbackAnswer({
      peer: entity,
      msgId: Number(messageId),
      data: Buffer.from(data, "base64")
    })), 15000, "机器人响应超时，请稍后再试");
  } catch (error) {
    if (String(error.message || "").includes("TIMEOUT")) {
      throw Object.assign(new Error("机器人响应超时，请稍后再试"), { status: 504 });
    }
    throw error;
  }
  return {
    message: answer.message || "",
    url: answer.url || "",
    alert: Boolean(answer.alert)
  };
}

async function resolveTelegramLink(userId, accountId, url) {
  const domain = linkDomain(url);
  const client = await getClient(userId, accountId);
  if (!peerCache.has(accountId)) await listChats(userId, accountId);
  const privatePeerId = linkPrivatePeerId(url);
  let entity = null;
  if (privatePeerId) entity = peerCache.get(accountId)?.get(privatePeerId) || null;
  if (!entity && domain) entity = await client.getEntity(domain);
  if (!entity) throw Object.assign(new Error("这个链接暂不支持在客户端内打开，或你当前账号无权访问"), { status: 400 });
  const chat = serializeEntity(entity);
  if (!peerCache.has(accountId)) peerCache.set(accountId, new Map());
  peerCache.get(accountId).set(chat.id, entity);
  return { ...chat, avatarKey: chat.id, messageId: linkMessageId(url) };
}

async function search(userId, accountId, query) {
  const client = await getClient(userId, accountId);
  const dialogs = await listChats(userId, accountId, query);
  const global = query
    ? await client.getMessages(undefined, { search: query, limit: 30 }).catch(() => [])
    : [];
  return {
    chats: dialogs,
    messages: global.map(serializeMessage)
  };
}

async function mediaFileInfo(userId, accountId, message, contentType, kind) {
  const directories = await cacheSettings();
  const extension = mime.extension(contentType);
  const guessedName = safeName(message.file?.name || `telegram-${accountId}-${message.id}${extension ? `.${extension}` : ""}`);
  const downloadDir = path.join(kind === "image" ? directories.image : kind === "video" ? directories.video : directories.file, userId);
  return {
    fileName: guessedName,
    filePath: path.join(downloadDir, guessedName),
    downloadDir
  };
}

function downloadTaskId(userId, accountId, peerId, messageId) {
  return stableId("download", userId, accountId, peerId, messageId);
}

function silentCacheTaskId(userId, accountId, peerId, messageId) {
  return stableId("silent", userId, accountId, peerId, messageId);
}

function silentDedupKey(userId, accountId, peerId, fileName, size) {
  return [userId, accountId, peerId, String(fileName || "").trim().toLowerCase(), Number(size || 0)].join("|");
}

function serializeDownloadTask(task) {
  return {
    id: task.id,
    accountId: task.accountId,
    peerId: task.peerId,
    messageId: task.messageId,
    fileName: task.fileName,
    kind: task.kind,
    contentType: task.contentType,
    status: task.status,
    size: task.size,
    downloaded: task.downloaded,
    speedBps: task.speedBps,
    error: task.error || "",
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    inlineUrl: task.status === "completed"
      ? `/api/media/${task.accountId}/${encodeURIComponent(task.peerId)}/${task.messageId}?inline=1`
      : ""
  };
}

function emitDownloadTask(io, task) {
  if (io) io.to(`user:${task.userId}`).emit("download:update", serializeDownloadTask(task));
  schedulePersistDownloads();
}

function serializeSilentCacheTask(task) {
  return {
    id: task.id,
    accountId: task.accountId,
    peerId: task.peerId,
    messageId: task.messageId,
    fileName: task.fileName,
    contentType: task.contentType,
    size: task.size,
    downloaded: task.downloaded || 0,
    speedBps: task.speedBps || 0,
    order: task.order || 0,
    status: task.status,
    error: task.error || "",
    createdAt: task.createdAt,
    updatedAt: task.updatedAt
  };
}

function serializeSilentCacheState(userId) {
  return {
    enabled: silentCacheEnabled,
    rateLimitBps: silentCacheRateLimitBps,
    concurrency: silentConcurrencyLimit(),
    running: silentCacheActive,
    tasks: listSilentCacheTasks(userId)
  };
}

function emitSilentCacheTask(io, task) {
  const target = io || realtimeIo;
  if (target) target.to(`user:${task.userId}`).emit("silent-cache:update", serializeSilentCacheTask(task));
  schedulePersistSilent();
}

function emitSilentCacheDelete(io, task) {
  const target = io || realtimeIo;
  if (target) target.to(`user:${task.userId}`).emit("silent-cache:delete", { id: task.id });
  schedulePersistSilent();
}

async function mediaMessage(userId, accountId, peerId, messageId) {
  const client = await getClient(userId, accountId);
  const entity = await resolvePeer(userId, accountId, peerId);
  const [message] = await client.getMessages(entity, { ids: [Number(messageId)] });
  if (!message || !message.media) throw Object.assign(new Error("这条消息没有可下载媒体"), { status: 404 });
  return { client, entity, message };
}

function silentPartSizeKb() {
  const rate = Number(silentCacheRateLimitBps || 0);
  if (!rate) return 512;
  const perTaskRate = rate / silentConcurrencyLimit();
  if (perTaskRate >= 768 * 1024) return 512;
  if (perTaskRate >= 256 * 1024) return 256;
  if (perTaskRate >= 128 * 1024) return 128;
  return 64;
}

async function readTelegramDocumentChunks(client, doc, offset, bytesToRead, onChunk) {
  let currentOffset = Math.max(0, Number(offset || 0));
  let remaining = Math.max(0, Number(bytesToRead || 0));
  const fileLocation = inputDocumentFileLocation(doc);
  if (!fileLocation) throw new Error("无法定位 Telegram 文档文件");
  const requestSize = MAX_TELEGRAM_CHUNK_SIZE;
  const metrics = {
    requestedChunkSize: requestSize,
    effectiveChunkSize: requestSize,
    fallbackCount: 0,
    limitInvalidCount: 0,
    dcId: doc.dcId
  };
  const limit = Math.ceil(remaining / requestSize);
  for await (const chunk of client.iterDownload({
    file: fileLocation,
    offset: bigInt(currentOffset),
    requestSize,
    chunkSize: requestSize,
    fileSize: bigInt(currentOffset + remaining),
    limit,
    dcId: doc.dcId
  })) {
    if (!chunk?.length) break;
    await onChunk(chunk, currentOffset, metrics);
    currentOffset += chunk.length;
    remaining -= chunk.length;
    if (remaining <= 0 || chunk.length < requestSize) break;
  }
  metrics.bytesRead = currentOffset - Math.max(0, Number(offset || 0));
  return metrics;
}

async function downloadSilentMedia(client, entity, message, outputFile, progressCallback) {
  if (message.document) {
    const doc = message.document;
    const total = Number(doc.size?.toString?.() || doc.size || message.file?.size || 0);
    const stat = await fs.stat(outputFile).catch(() => null);
    let downloaded = Math.max(0, Number(stat?.size || 0));
    if (total && downloaded > total) {
      await fs.remove(outputFile).catch(() => {});
      downloaded = 0;
    }
    if (downloaded % TELEGRAM_MIN_CHUNK_SIZE !== 0) {
      downloaded -= downloaded % TELEGRAM_MIN_CHUNK_SIZE;
      await fs.truncate(outputFile, downloaded).catch(() => {});
    }
    if (total && downloaded >= total) {
      await progressCallback(bigInt(downloaded), bigInt(total));
      return;
    }
    const writer = fs.createWriteStream(outputFile, { flags: downloaded > 0 ? "a" : "w" });
    try {
      const bytesToRead = total ? total - downloaded : Number.MAX_SAFE_INTEGER;
      await readTelegramDocumentChunks(client, doc, downloaded, bytesToRead, async (chunk) => {
        await new Promise((resolve, reject) => {
          writer.write(chunk, (error) => error ? reject(error) : resolve());
        });
        downloaded += chunk.length;
        await progressCallback(bigInt(downloaded), bigInt(total || downloaded));
      });
    } finally {
      await new Promise((resolve) => writer.end(resolve));
    }
    return;
  }
  await client.downloadMedia(message, { outputFile, progressCallback });
}

async function ensureDownloadTask(userId, accountId, peerId, messageId) {
  const id = downloadTaskId(userId, accountId, peerId, messageId);
  const existing = downloadTasks.get(id);
  if (existing) return existing;
  const { message } = await mediaMessage(userId, accountId, peerId, messageId);
  const contentType = message.photo ? "image/jpeg" : message.document?.mimeType || "";
  const kind = mediaKind(message, contentType);
  const size = Number(message.file?.size || message.document?.size || 0);
  const { fileName, filePath, downloadDir } = await mediaFileInfo(userId, accountId, message, contentType, kind);
  const task = {
    id,
    userId,
    accountId,
    peerId,
    messageId: Number(messageId),
    fileName,
    filePath,
    partPath: `${filePath}.part`,
    downloadDir,
    kind,
    contentType: contentType || mime.lookup(fileName) || "application/octet-stream",
    size,
    downloaded: 0,
    speedBps: 0,
    status: "queued",
    error: "",
    cancelToken: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  downloadTasks.set(id, task);
  schedulePersistDownloads();
  return task;
}

async function startDownloadTask(userId, accountId, peerId, messageId, io) {
  const task = await ensureDownloadTask(userId, accountId, peerId, messageId);
  if (task.userId !== userId) throw Object.assign(new Error("无权访问这个下载任务"), { status: 403 });
  if (task.status === "downloading") return serializeDownloadTask(task);
  if (await fs.pathExists(task.filePath)) {
    const stat = await fs.stat(task.filePath);
    task.downloaded = stat.size;
    task.size = task.size || stat.size;
    task.status = "completed";
    task.speedBps = 0;
    task.updatedAt = new Date().toISOString();
    emitDownloadTask(io, task);
    return serializeDownloadTask(task);
  }
  const partStat = await fs.stat(task.partPath).catch(() => null);
  if (partStat) task.downloaded = partStat.size;
  task.status = "queued";
  task.error = "";
  task.updatedAt = new Date().toISOString();
  emitDownloadTask(io, task);
  runDownloadTask(task, io).catch(() => {});
  return serializeDownloadTask(task);
}

async function runDownloadTask(task, io) {
  if (task.status === "downloading") return;
  const cancelToken = { cancelled: false, paused: false };
  task.cancelToken = cancelToken;
  task.status = "downloading";
  task.error = "";
  task.updatedAt = new Date().toISOString();
  emitDownloadTask(io, task);
  try {
    const { client, message } = await mediaMessage(task.userId, task.accountId, task.peerId, task.messageId);
    await fs.ensureDir(task.downloadDir);
    if (await fs.pathExists(task.filePath)) {
      const stat = await fs.stat(task.filePath);
      task.downloaded = stat.size;
      task.size = task.size || stat.size;
      task.status = "completed";
      task.updatedAt = new Date().toISOString();
      emitDownloadTask(io, task);
      return;
    }
    const total = task.size || Number(message.file?.size || message.document?.size || 0);
    task.size = total;
    let lastBytes = 0;
    let lastTick = Date.now();
    const partStat = await fs.stat(task.partPath).catch(() => null);
    task.downloaded = partStat?.size || 0;
    await fs.remove(task.partPath).catch(() => {});
    const progressCallback = async (downloadedValue, totalValue) => {
      if (cancelToken.cancelled) {
        throw Object.assign(new Error("下载已取消"), { status: 499 });
      }
      const downloaded = Number(downloadedValue?.toString?.() || downloadedValue || 0);
      const fullSize = Number(totalValue?.toString?.() || totalValue || total || 0);
      task.downloaded = downloaded;
      task.size = fullSize || task.size;
      const now = Date.now();
      if (now - lastTick >= 800 || downloaded >= fullSize) {
        task.speedBps = Math.max(0, Math.round((downloaded - lastBytes) / Math.max(0.001, (now - lastTick) / 1000)));
        task.updatedAt = new Date().toISOString();
        lastTick = now;
        lastBytes = downloaded;
        emitDownloadTask(io, task);
      }
    };
    await client.downloadMedia(message, { outputFile: task.partPath, progressCallback });
    if (cancelToken.cancelled) return;
    await fs.move(task.partPath, task.filePath, { overwrite: true });
    const stat = await fs.stat(task.filePath);
    task.downloaded = stat.size;
    task.size = task.size || stat.size;
    task.speedBps = 0;
    task.status = "completed";
    task.updatedAt = new Date().toISOString();
    emitDownloadTask(io, task);
  } catch (error) {
    if (error.status !== 499 && isTransientDownloadError(error) && Number(task.retryCount || 0) < DOWNLOAD_RETRY_LIMIT) {
      task.retryCount = Number(task.retryCount || 0) + 1;
      task.status = "queued";
      task.error = `网络波动，自动重试 ${task.retryCount}/${DOWNLOAD_RETRY_LIMIT}`;
      task.speedBps = 0;
      task.updatedAt = new Date().toISOString();
      emitDownloadTask(io, task);
      setTimeout(() => {
        if (downloadTasks.get(task.id)?.status === "queued") runDownloadTask(task, io).catch(() => {});
      }, Math.min(30000, 3000 * task.retryCount)).unref?.();
      return;
    }
    task.status = error.status === 499 ? "cancelled" : "error";
    task.error = error.status === 499 ? "" : error.message || "下载失败";
    task.speedBps = 0;
    task.updatedAt = new Date().toISOString();
    emitDownloadTask(io, task);
  } finally {
    task.cancelToken = null;
  }
}

async function cacheVideoSilently(userId, accountId, peerId, message) {
  const contentType = message.document?.mimeType || "";
  const kind = mediaKind(message, contentType);
  const size = Number(message.file?.size || message.document?.size || 0);
  if (kind !== "video" || size <= VIDEO_CACHE_THRESHOLD) return false;
  const key = silentCacheTaskId(userId, accountId, peerId, message.id);
  const existingSilent = silentCacheRecords.get(key);
  if (silentCacheTasks.has(key) || (existingSilent && ["queued", "running", "completed"].includes(existingSilent.status))) return false;
  const visibleTask = downloadTasks.get(downloadTaskId(userId, accountId, peerId, message.id));
  if (visibleTask && ["queued", "downloading", "completed"].includes(visibleTask.status)) return false;
  const mediaInfo = await mediaFileInfo(userId, accountId, message, contentType, kind);
  const { filePath, downloadDir } = mediaInfo;
  const dedupKey = silentDedupKey(userId, accountId, peerId, mediaInfo.fileName, size);
  const duplicate = [...silentCacheRecords.values()].find((task) => (
    task.dedupKey === dedupKey ||
    (!task.dedupKey && silentDedupKey(task.userId, task.accountId, task.peerId, task.fileName, task.size) === dedupKey)
  ));
  if (duplicate && !["cancelled"].includes(duplicate.status)) return false;
  const partPath = `${filePath}.silent.part`;
  if (await fs.pathExists(filePath)) return false;
  const record = {
    id: key,
    userId,
    accountId,
    peerId,
    messageId: Number(message.id),
    fileName: mediaInfo.fileName,
    filePath,
    partPath,
    downloadDir,
    contentType,
    size,
    dedupKey,
    order: nextSilentOrder(),
    downloaded: 0,
    speedBps: 0,
    cancelToken: null,
    retryCount: 0,
    lastProgressAt: new Date().toISOString(),
    status: "queued",
    error: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  silentCacheRecords.set(key, record);
  enqueueSilentTask(record);
  emitSilentCacheTask(realtimeIo, record);
  pumpSilentCacheQueue(realtimeIo);
  return true;
}

function pumpSilentCacheQueue(io = realtimeIo) {
  if (!silentCacheEnabled) return;
  while (silentCacheActive < silentConcurrencyLimit() && silentCacheQueue.length) {
    const record = silentCacheQueue.shift();
    if (!record || silentCacheTasks.has(record.id) || ["completed", "cancelled"].includes(record.status)) continue;
    silentCacheActive += 1;
    const runToken = { detached: false, startedAt: Date.now() };
    record.runToken = runToken;
    record.status = "running";
    record.error = "";
    record.speedBps = 0;
    record.updatedAt = new Date().toISOString();
    emitSilentCacheTask(io, record);
    const promise = runSilentCacheTask(record, io, runToken)
      .catch((error) => {
        if (isTransientDownloadError(error) && silentCacheRecords.has(record.id)) {
          const fileReferenceExpired = isFileReferenceExpired(error);
          resetTelegramClient(record.accountId).catch(() => {});
          record.retryCount = Number(record.retryCount || 0) + 1;
          record.status = "queued";
          record.error = fileReferenceExpired ? "文件引用过期，已刷新后重试" : "Telegram 连接波动，已重置账号连接并等待续传";
          record.speedBps = 0;
          record.updatedAt = new Date().toISOString();
          emitSilentCacheTask(io, record);
          setTimeout(() => {
            const current = silentCacheRecords.get(record.id);
            if (current && current.status === "queued") {
              enqueueSilentTask(current);
              pumpSilentCacheQueue(io);
            }
          }, fileReferenceExpired ? 3000 : Math.min(60 * 1000, 3000 * Math.min(10, record.retryCount))).unref?.();
          return;
        }
        record.status = "error";
        record.error = error.message || "后台缓存失败";
        record.speedBps = 0;
        record.updatedAt = new Date().toISOString();
        emitSilentCacheTask(io, record);
      })
      .finally(() => {
        if (!runToken.detached) silentCacheActive = Math.max(0, silentCacheActive - 1);
        if (record.runToken === runToken) {
          record.runToken = null;
          silentCacheTasks.delete(record.id);
          if (silentCacheRecords.has(record.id)) emitSilentCacheTask(io, record);
          pumpSilentCacheQueue(io);
        }
      });
    silentCacheTasks.set(record.id, promise);
  }
}

async function runSilentCacheTask(record, io = realtimeIo, runToken = null) {
  if (await fs.pathExists(record.filePath)) {
    const stat = await fs.stat(record.filePath).catch(() => null);
    if (stat) {
      record.downloaded = stat.size;
      record.size = record.size || stat.size;
    }
    record.status = "completed";
    record.error = "";
    record.speedBps = 0;
    record.updatedAt = new Date().toISOString();
    emitSilentCacheTask(io, record);
    return;
  }
  const client = await getCacheClient(record.userId, record.accountId);
  const entity = await resolvePeer(record.userId, record.accountId, record.peerId);
  const [message] = await client.getMessages(entity, { ids: [Number(record.messageId)] });
  if (!message || !message.media) throw Object.assign(new Error("这条消息没有可下载媒体"), { status: 404 });
  await fs.ensureDir(record.downloadDir);
  const total = record.size || Number(message.file?.size || message.document?.size || 0);
  record.size = total;
  const partStat = await fs.stat(record.partPath).catch(() => null);
  const existingDownloaded = Math.max(0, Number(partStat?.size || 0));
  if (existingDownloaded) record.downloaded = existingDownloaded;
  record.lastObservedPartSize = existingDownloaded;
  record.lastObservedAt = new Date().toISOString();
  let lastBytes = existingDownloaded;
  let lastTick = Date.now();
  let lastThrottleBytes = existingDownloaded;
  const cancelToken = { cancelled: false, paused: false };
  record.cancelToken = cancelToken;
  const progressCallback = async (downloadedValue, totalValue) => {
    if (cancelToken.cancelled || cancelToken.paused || !silentCacheEnabled) {
      throw Object.assign(new Error(cancelToken.detached ? "后台缓存重排" : cancelToken.cancelled ? "后台缓存已取消" : "后台缓存已暂停"), {
        status: 499,
        paused: cancelToken.paused || !silentCacheEnabled,
        requeue: cancelToken.requeue,
        detached: cancelToken.detached
      });
    }
    const downloaded = Number(downloadedValue?.toString?.() || downloadedValue || 0);
    const fullSize = Number(totalValue?.toString?.() || totalValue || total || 0);
    record.downloaded = downloaded;
    record.size = fullSize || record.size;
    await throttleSilentCache(downloaded - lastThrottleBytes);
    lastThrottleBytes = downloaded;
    if (cancelToken.cancelled || cancelToken.paused || !silentCacheEnabled) {
      throw Object.assign(new Error(cancelToken.detached ? "后台缓存重排" : cancelToken.cancelled ? "后台缓存已取消" : "后台缓存已暂停"), {
        status: 499,
        paused: cancelToken.paused || !silentCacheEnabled,
        requeue: cancelToken.requeue,
        detached: cancelToken.detached
      });
    }
    const now = Date.now();
    if (now - lastTick >= 1000 || downloaded >= fullSize) {
      record.speedBps = Math.max(0, Math.round((downloaded - lastBytes) / Math.max(0.001, (now - lastTick) / 1000)));
      const progressAt = new Date().toISOString();
      record.lastProgressAt = progressAt;
      record.lastObservedPartSize = downloaded;
      record.lastObservedAt = progressAt;
      record.updatedAt = progressAt;
      lastTick = now;
      lastBytes = downloaded;
      emitSilentCacheTask(io, record);
    }
  };
  try {
    await downloadSilentMedia(client, entity, message, record.partPath, progressCallback);
    await fs.move(record.partPath, record.filePath, { overwrite: true });
    const stat = await fs.stat(record.filePath).catch(() => null);
    if (stat) record.downloaded = stat.size;
    record.status = "completed";
    record.error = "";
    record.speedBps = 0;
    record.lastProgressAt = new Date().toISOString();
    record.updatedAt = new Date().toISOString();
    emitSilentCacheTask(io, record);
  } catch (error) {
    if (error.status === 499 && (error.requeue || error.detached)) {
      if (runToken && record.runToken !== runToken) return;
      record.status = "queued";
      record.error = "";
      enqueueSilentTask(record);
    } else if (error.status === 499 && error.paused) {
      if (runToken && record.runToken !== runToken) return;
      if (silentCacheEnabled) {
        record.status = "queued";
        enqueueSilentTask(record);
      } else {
        record.status = "paused";
      }
      record.error = "";
    } else if (error.status === 499) {
      if (!silentCacheRecords.has(record.id)) return;
      if (runToken && record.runToken !== runToken) return;
      record.status = "cancelled";
      record.error = "";
    } else {
      throw error;
    }
    record.speedBps = 0;
    record.updatedAt = new Date().toISOString();
    emitSilentCacheTask(io, record);
  } finally {
    if (!runToken || record.runToken === runToken) record.cancelToken = null;
  }
}

async function cacheLargeVideosInChat(userId, accountId, peerId, io = realtimeIo) {
  realtimeIo = io || realtimeIo;
  const client = await getClient(userId, accountId);
  const entity = await resolvePeer(userId, accountId, peerId);
  const recent = await client.getMessages(entity, { limit: 120 }).catch(() => []);
  let queued = 0;
  for (const message of recent) {
    if (!message?.media) continue;
    if (await cacheVideoSilently(userId, accountId, peerId, message)) queued += 1;
  }
  pumpSilentCacheQueue(io);
  return { queued };
}

function listDownloadTasks(userId) {
  return [...downloadTasks.values()]
    .filter((task) => task.userId === userId)
    .sort((a, b) => String(b.createdAt || b.updatedAt).localeCompare(String(a.createdAt || a.updatedAt)))
    .map(serializeDownloadTask);
}

function listSilentCacheTasks(userId) {
  return [...silentCacheRecords.values()]
    .filter((task) => task.userId === userId && task.status !== "cancelled")
    .sort((a, b) => {
      const orderDiff = Number(a.order || 0) - Number(b.order || 0);
      if (orderDiff) return orderDiff;
      return String(b.createdAt || b.updatedAt).localeCompare(String(a.createdAt || a.updatedAt));
    })
    .map(serializeSilentCacheTask);
}

async function silentCacheSpeedDiagnostics(userId, payload = {}) {
  monitorSilentCacheTasks(realtimeIo);
  const maxSampleBytes = 32 * 1024 * 1024;
  const forceProbe = Boolean(payload.forceProbe);
  const sampleBytes = Math.max(512 * 1024, Math.min(maxSampleBytes, Number(payload.sampleBytes || 1024 * 1024)));
  const tasks = [...silentCacheRecords.values()].filter((task) => task.userId === userId);
  const runningTasks = tasks.filter((task) => task.status === "running");
  const candidate = tasks.find((task) => ["queued", "paused", "error"].includes(task.status)) ||
    runningTasks[0] ||
    tasks[0];
  const activeTasks = tasks
    .filter((task) => ["running", "queued", "paused", "error"].includes(task.status))
    .sort((a, b) => Number(a.order || 0) - Number(b.order || 0))
    .slice(0, 20)
    .map(serializeSilentCacheTask);
  const base = {
    testedAt: new Date().toISOString(),
    enabled: silentCacheEnabled,
    rateLimitBps: silentCacheRateLimitBps,
    concurrency: silentConcurrencyLimit(),
    running: silentCacheActive,
    queued: silentCacheQueue.length,
    partSizeKb: silentPartSizeKb(),
    directChunkSize: MAX_TELEGRAM_CHUNK_SIZE,
    sampleBytes,
    activeTasks
  };
  if (!candidate) return { ...base, ok: false, error: "暂无后台缓存任务，先在群组信息里勾选后台缓存后再测试。" };
  if (runningTasks.length && !forceProbe) {
    const aggregateSpeedBps = runningTasks.reduce((sum, task) => sum + Number(task.speedBps || 0), 0);
    return {
      ...base,
      ok: true,
      mode: "aggregate",
      task: serializeSilentCacheTask(runningTasks[0]),
      result: {
        bytesRead: 0,
        chunks: 0,
        durationMs: 0,
        speedBps: aggregateSpeedBps,
        runningTasks: runningTasks.length,
        requestedChunkSize: 0,
        effectiveChunkSize: 0,
        fallbackCount: 0,
        limitInvalidCount: 0
      },
      note: "当前已有后台缓存任务运行，诊断使用运行任务聚合速度，未额外读取 Telegram 文件。"
    };
  }
  try {
    const { client, message } = await mediaMessage(candidate.userId, candidate.accountId, candidate.peerId, candidate.messageId);
    if (!message.document) return { ...base, ok: false, task: serializeSilentCacheTask(candidate), error: "当前任务不是 document 视频，无法执行 Telegram 分片测速。" };
    const total = Number(message.document.size?.toString?.() || message.document.size || message.file?.size || candidate.size || 0);
    const partStat = await fs.stat(candidate.partPath).catch(() => null);
    const downloaded = Math.max(0, Number(partStat?.size || candidate.downloaded || 0));
    let safeOffset = total ? Math.min(downloaded, Math.max(0, total - 512 * 1024)) : downloaded;
    safeOffset -= safeOffset % TELEGRAM_MIN_CHUNK_SIZE;
    const targetBytes = total ? Math.min(sampleBytes, Math.max(0, total - safeOffset)) : sampleBytes;
    const started = Date.now();
    let chunks = 0;
    const metrics = await readTelegramDocumentChunks(client, message.document, safeOffset, targetBytes, async () => {
      chunks += 1;
    });
    const durationMs = Math.max(1, Date.now() - started);
    const bytesRead = metrics.bytesRead || 0;
    return {
      ...base,
      ok: true,
      task: {
        ...serializeSilentCacheTask(candidate),
        dcId: message.document.dcId,
        mimeType: message.document.mimeType || "",
        savedPartBytes: downloaded,
        testOffset: safeOffset
      },
      result: {
        bytesRead,
        chunks,
        durationMs,
        speedBps: Math.round((bytesRead / durationMs) * 1000),
        requestedChunkSize: metrics.requestedChunkSize,
        effectiveChunkSize: metrics.effectiveChunkSize,
        fallbackCount: metrics.fallbackCount,
        limitInvalidCount: metrics.limitInvalidCount
      }
    };
  } catch (error) {
    return {
      ...base,
      ok: false,
      task: serializeSilentCacheTask(candidate),
      error: error.message || String(error)
    };
  }
}

function setSilentCacheControl(userId, payload = {}, io = realtimeIo) {
  const wasEnabled = silentCacheEnabled;
  if (payload.enabled !== undefined) {
    silentCacheEnabled = Boolean(payload.enabled);
    if (silentCacheEnabled && !wasEnabled) resetSilentRateWindow();
  }
  if (payload.rateLimitBps !== undefined) {
    silentCacheRateLimitBps = Math.max(0, Math.min(1024 * 1024 * 1024, Number(payload.rateLimitBps || 0)));
    resetSilentRateWindow();
    rebalanceSilentConcurrency(io);
  }
  if (payload.concurrency !== undefined) {
    silentCacheConcurrency = Math.max(1, Math.min(MAX_SILENT_CACHE_CONCURRENCY, Number(payload.concurrency || 1)));
    resetSilentRateWindow();
    rebalanceSilentConcurrency(io);
  }
  if (!silentCacheEnabled) {
    for (const task of silentCacheRecords.values()) {
      if (task.userId !== userId) continue;
      if (task.cancelToken) {
        task.cancelToken.paused = true;
        task.cancelToken.requeue = false;
      }
      if (["queued", "running"].includes(task.status)) {
        task.status = "paused";
        task.speedBps = 0;
        task.updatedAt = new Date().toISOString();
        emitSilentCacheTask(io, task);
      }
    }
    silentCacheQueue.splice(0, silentCacheQueue.length, ...silentCacheQueue.filter((task) => task.userId !== userId));
  } else {
    for (const task of silentCacheRecords.values()) {
      if (task.userId !== userId) continue;
      if (["paused", "error"].includes(task.status)) {
        if (task.cancelToken) {
          task.cancelToken.paused = true;
          task.cancelToken.requeue = true;
        }
        if (silentCacheTasks.has(task.id)) {
          task.status = "queued";
          task.error = "";
          task.speedBps = 0;
          task.updatedAt = new Date().toISOString();
          emitSilentCacheTask(io, task);
          continue;
        }
        task.status = "queued";
        task.error = "";
        task.speedBps = 0;
        task.updatedAt = new Date().toISOString();
        enqueueSilentTask(task);
        emitSilentCacheTask(io, task);
      }
    }
    pumpSilentCacheQueue(io);
  }
  schedulePersistSilent();
  return serializeSilentCacheState(userId);
}

function reorderSilentCacheTasks(userId, orderedIds = [], io = realtimeIo) {
  const ids = Array.isArray(orderedIds) ? orderedIds : [];
  ids.forEach((id, index) => {
    const task = silentCacheRecords.get(id);
    if (task && task.userId === userId) {
      task.order = index + 1;
      task.updatedAt = new Date().toISOString();
    }
  });
  silentCacheQueue.sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
  for (const task of silentCacheRecords.values()) {
    if (task.userId === userId) emitSilentCacheTask(io, task);
  }
  schedulePersistSilent();
  return serializeSilentCacheState(userId);
}

function monitorSilentCacheTasks(io = realtimeIo) {
  if (!silentCacheEnabled) return;
  const now = Date.now();
  for (const task of silentCacheRecords.values()) {
    if (task.status === "completed") continue;
    if (task.filePath && fs.existsSync(task.filePath)) {
      const stat = fs.statSync(task.filePath);
      task.downloaded = stat.size;
      task.size = task.size || stat.size;
      task.status = "completed";
      task.speedBps = 0;
      task.error = "";
      task.updatedAt = new Date().toISOString();
      emitSilentCacheTask(io, task);
      continue;
    }
    const partStat = task.partPath && fs.existsSync(task.partPath) ? fs.statSync(task.partPath) : null;
    const partSize = Math.max(0, Number(partStat?.size || 0));
    if (partSize > Number(task.downloaded || 0)) {
      task.downloaded = partSize;
      task.lastProgressAt = new Date(now).toISOString();
      task.lastObservedPartSize = partSize;
      task.lastObservedAt = task.lastProgressAt;
      task.updatedAt = task.lastProgressAt;
      emitSilentCacheTask(io, task);
      continue;
    }
    if (partSize !== Number(task.lastObservedPartSize || 0)) {
      task.lastObservedPartSize = partSize;
      task.lastObservedAt = new Date(now).toISOString();
    }
    const lastProgress = Date.parse(task.lastProgressAt || task.updatedAt || task.createdAt || 0) || 0;
    const stale = task.status === "running" && lastProgress && now - lastProgress > STALE_TASK_MS;
    const idle = task.status === "running" && lastProgress && now - lastProgress > IDLE_SPEED_RESET_MS;
    if (idle && task.speedBps) {
      task.speedBps = 0;
      task.updatedAt = new Date().toISOString();
      emitSilentCacheTask(io, task);
    }
    if (["error", "paused", "queued"].includes(task.status) || stale) {
      if (stale && task.status === "running" && task.cancelToken) {
        task.cancelToken.paused = true;
        task.cancelToken.requeue = true;
        resetTelegramClient(task.accountId).catch(() => {});
        task.error = "真实写盘停滞，已重置账号连接并等待续传";
        task.speedBps = 0;
        task.updatedAt = new Date().toISOString();
        emitSilentCacheTask(io, task);
        continue;
      }
      task.status = "queued";
      task.error = stale ? "真实写盘停滞，已重新排队" : task.error || "";
      task.speedBps = 0;
      task.updatedAt = new Date().toISOString();
      enqueueSilentTask(task);
      emitSilentCacheTask(io, task);
    }
  }
  pumpSilentCacheQueue(io);
}

function cancelSilentCacheTask(userId, taskId, io = realtimeIo) {
  const task = silentCacheRecords.get(taskId);
  if (!task || task.userId !== userId) throw Object.assign(new Error("找不到后台缓存任务"), { status: 404 });
  if (task.cancelToken) task.cancelToken.cancelled = true;
  const index = silentCacheQueue.findIndex((item) => item.id === task.id);
  if (index >= 0) silentCacheQueue.splice(index, 1);
  silentCacheRecords.delete(task.id);
  emitSilentCacheDelete(io, task);
  return { ok: true, id: task.id };
}

async function resumeDownloadTask(userId, taskId, io) {
  const task = downloadTasks.get(taskId);
  if (!task || task.userId !== userId) throw Object.assign(new Error("找不到下载任务"), { status: 404 });
  return startDownloadTask(userId, task.accountId, task.peerId, task.messageId, io);
}

function cancelDownloadTask(userId, taskId, io) {
  const task = downloadTasks.get(taskId);
  if (!task || task.userId !== userId) throw Object.assign(new Error("找不到下载任务"), { status: 404 });
  if (task.cancelToken) task.cancelToken.cancelled = true;
  if (task.status !== "completed") task.status = "cancelled";
  task.speedBps = 0;
  task.updatedAt = new Date().toISOString();
  emitDownloadTask(io, task);
  return serializeDownloadTask(task);
}

async function mediaThumbnail(userId, accountId, peerId, messageId) {
  const { client, message } = await mediaMessage(userId, accountId, peerId, messageId);
  const contentType = message.photo ? "image/jpeg" : message.document?.mimeType || "";
  const kind = mediaKind(message, contentType);
  const directories = await cacheSettings();
  const thumbDir = path.join(directories.thumbs, userId);
  await fs.ensureDir(thumbDir);
  const filePath = path.join(thumbDir, `${safeId(`${accountId}-${peerId}-${messageId}`)}.jpg`);
  if (await fs.pathExists(filePath)) {
    return { filePath, contentType: "image/jpeg" };
  }

  const thumbCount = message.document?.thumbs?.length || message.photo?.sizes?.length || 0;
  if (thumbCount) {
    const buffer = await client.downloadMedia(message, { thumb: thumbCount - 1 }).catch(() => null);
    if (buffer?.length) {
      await fs.writeFile(filePath, buffer);
      return { filePath, contentType: "image/jpeg" };
    }
  }

  if (kind === "image") {
    const media = await downloadMedia(userId, accountId, peerId, messageId, { forceCache: true });
    return { filePath: media.filePath, contentType: media.contentType };
  }

  throw Object.assign(new Error("暂无视频封面"), { status: 404 });
}

async function deleteDownloadTask(userId, taskId, io) {
  const task = downloadTasks.get(taskId);
  if (!task || task.userId !== userId) throw Object.assign(new Error("找不到下载任务"), { status: 404 });
  if (task.cancelToken) task.cancelToken.cancelled = true;
  await fs.remove(task.partPath).catch(() => {});
  await fs.remove(task.filePath).catch(() => {});
  downloadTasks.delete(taskId);
  schedulePersistDownloads();
  if (io) io.to(`user:${userId}`).emit("download:delete", { id: taskId });
  return { ok: true };
}

function clearDownloadTask(userId, taskId, io) {
  const task = downloadTasks.get(taskId);
  if (!task || task.userId !== userId) throw Object.assign(new Error("找不到下载任务"), { status: 404 });
  if (task.cancelToken) task.cancelToken.cancelled = true;
  downloadTasks.delete(taskId);
  schedulePersistDownloads();
  if (io) io.to(`user:${userId}`).emit("download:delete", { id: taskId });
  return { ok: true };
}

async function downloadMedia(userId, accountId, peerId, messageId, options = {}) {
  const client = await getClient(userId, accountId);
  const entity = await resolvePeer(userId, accountId, peerId);
  const [message] = await client.getMessages(entity, { ids: [Number(messageId)] });
  if (!message || !message.media) throw Object.assign(new Error("这条消息没有可下载媒体"), { status: 404 });
  const contentType = message.photo ? "image/jpeg" : message.document?.mimeType || "";
  const kind = mediaKind(message, contentType);
  const rawSize = Number(message.file?.size || message.document?.size || 0);
  const cacheable = options.forceCache || kind === "image" || (kind === "video" && rawSize > VIDEO_CACHE_THRESHOLD);
  const { fileName, filePath, downloadDir } = await mediaFileInfo(userId, accountId, message, contentType, kind);
  if (!cacheable) {
    const buffer = await client.downloadMedia(message, {});
    return {
      buffer,
      fileName,
      contentType: contentType || mime.lookup(fileName) || "application/octet-stream",
      size: buffer.length,
      kind,
      cacheable: false
    };
  }
  await fs.ensureDir(downloadDir);
  if (!(await fs.pathExists(filePath))) {
    const buffer = await client.downloadMedia(message, {});
    await fs.writeFile(filePath, buffer);
  }
  const stat = await fs.stat(filePath);
  return {
    filePath,
    fileName,
    contentType: contentType || mime.lookup(filePath) || "application/octet-stream",
    size: stat.size,
    kind,
    cacheable: true
  };
}

async function cacheMedia(userId, accountId, peerId, messageId) {
  return downloadMedia(userId, accountId, peerId, messageId, { forceCache: true });
}

async function streamVideoMedia(userId, accountId, peerId, messageId, rangeHeader, res) {
  const client = await getClient(userId, accountId);
  const entity = await resolvePeer(userId, accountId, peerId);
  const [message] = await client.getMessages(entity, { ids: [Number(messageId)] });
  if (!message || !message.media) throw Object.assign(new Error("这条消息没有可播放媒体"), { status: 404 });
  const contentType = message.document?.mimeType || "";
  const kind = mediaKind(message, contentType);
  if (kind !== "video") return false;
  const size = Number(message.file?.size || message.document?.size || 0);
  if (!size) return false;
  const { fileName, filePath } = await mediaFileInfo(userId, accountId, message, contentType, kind);
  if (await fs.pathExists(filePath)) {
    const stat = await fs.stat(filePath);
    return streamLocalFile(filePath, fileName, contentType || mime.lookup(filePath) || "video/mp4", stat.size, rangeHeader, res, "private, max-age=86400");
  }
  return false;
  let start = 0;
  let end = size - 1;
  let statusCode = 200;
  if (rangeHeader) {
    const match = String(rangeHeader).match(/bytes=(\d*)-(\d*)/);
    if (match) {
      if (match[1]) start = Number(match[1]);
      if (match[2]) end = Number(match[2]);
      if (!match[1] && match[2]) {
        const suffix = Number(match[2]);
        start = Math.max(0, size - suffix);
        end = size - 1;
      }
      statusCode = 206;
    }
  }
  start = Math.max(0, Math.min(start, size - 1));
  end = Math.max(start, Math.min(end, size - 1));
  const contentLength = end - start + 1;
  res.writeHead(statusCode, {
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "Content-Disposition": `inline; filename="${encodeURIComponent(fileName)}"`,
    "Content-Length": contentLength,
    "Content-Type": contentType || mime.lookup(fileName) || "video/mp4",
    ...(statusCode === 206 ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {})
  });
  const chunkSize = 512 * 1024;
  const limit = Math.ceil(contentLength / chunkSize);
  let sent = 0;
  for await (const chunk of client.iterDownload({
    file: inputFileLocation(message),
    offset: bigInt(start),
    chunkSize,
    requestSize: chunkSize,
    limit,
    fileSize: bigInt(size)
  })) {
    if (res.destroyed) break;
    const remaining = contentLength - sent;
    if (remaining <= 0) break;
    const piece = chunk.length > remaining ? chunk.slice(0, remaining) : chunk;
    sent += piece.length;
    if (!res.write(piece)) {
      await new Promise((resolve) => res.once("drain", resolve));
    }
  }
  res.end();
  return true;
}

function streamLocalFile(filePath, fileName, contentType, size, rangeHeader, res, cacheControl = "private, max-age=86400") {
  let start = 0;
  let end = size - 1;
  let statusCode = 200;
  if (rangeHeader) {
    const match = String(rangeHeader).match(/bytes=(\d*)-(\d*)/);
    if (match) {
      if (match[1]) start = Number(match[1]);
      if (match[2]) end = Number(match[2]);
      if (!match[1] && match[2]) {
        const suffix = Number(match[2]);
        start = Math.max(0, size - suffix);
        end = size - 1;
      }
      statusCode = 206;
    }
  }
  start = Math.max(0, Math.min(start, size - 1));
  end = Math.max(start, Math.min(end, size - 1));
  res.writeHead(statusCode, {
    "Accept-Ranges": "bytes",
    "Cache-Control": cacheControl,
    "Content-Disposition": `inline; filename="${encodeURIComponent(fileName)}"`,
    "Content-Length": end - start + 1,
    "Content-Type": contentType,
    ...(statusCode === 206 ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {})
  });
  fs.createReadStream(filePath, { start, end }).pipe(res);
  return true;
}

async function profilePhoto(userId, accountId, peerId = "__self") {
  const client = await getClient(userId, accountId);
  const entity = peerId === "__self" ? await client.getMe() : await resolvePeer(userId, accountId, peerId);
  const directories = await cacheSettings();
  const avatarDir = path.join(directories.avatars, userId);
  await fs.ensureDir(avatarDir);
  const fileName = `${safeId("avatar")}.jpg`;
  const filePath = path.join(avatarDir, fileName);
  const buffer = await client.downloadProfilePhoto(entity, { isBig: false }).catch(() => null);
  if (!buffer) throw Object.assign(new Error("暂无头像"), { status: 404 });
  await fs.writeFile(filePath, buffer);
  return {
    filePath,
    fileName,
    contentType: "image/jpeg"
  };
}

async function cleanupCache() {
  const settings = await cacheSettings();
  const cutoff = Date.now() - settings.retentionDays * 24 * 60 * 60 * 1000;
  for (const dir of [settings.image, settings.video, settings.file, settings.avatars, settings.thumbs]) {
    if (!(await fs.pathExists(dir))) continue;
    const entries = await fs.readdir(dir).catch(() => []);
    for (const entry of entries) {
      const entryPath = path.join(dir, entry);
      const stat = await fs.stat(entryPath).catch(() => null);
      if (!stat) continue;
      if (stat.isDirectory()) {
        const files = await fs.readdir(entryPath).catch(() => []);
        for (const file of files) {
          const filePath = path.join(entryPath, file);
          const fileStat = await fs.stat(filePath).catch(() => null);
          if (fileStat && fileStat.mtimeMs < cutoff) await fs.remove(filePath).catch(() => {});
        }
      } else if (stat.mtimeMs < cutoff) {
        await fs.remove(entryPath).catch(() => {});
      }
    }
  }
}

module.exports = {
  clickMessageButton,
  completeCode,
  completePassword,
  cacheMedia,
  cacheLargeVideosInChat,
  cancelDownloadTask,
  chatDetails,
  chatMedia,
  clearDownloadTask,
  deleteDownloadTask,
  downloadMedia,
  mediaThumbnail,
  listDownloadTasks,
  listSilentCacheTasks,
  silentCacheSpeedDiagnostics,
  silentCacheState: serializeSilentCacheState,
  setSilentCacheControl,
  reorderSilentCacheTasks,
  monitorSilentCacheTasks,
  cancelSilentCacheTask,
  resumeDownloadTask,
  startDownloadTask,
  streamVideoMedia,
  listAccounts,
  listChats,
  listFolders,
  listMessages,
  loadSavedClients,
  logout,
  cleanupCache,
  profilePhoto,
  resolveTelegramLink,
  restoreBackgroundTasks,
  search,
  sendText,
  startLogin,
  async reconnectAll(io) {
    for (const client of clients.values()) {
      try {
        await client.disconnect();
      } catch {}
    }
    clients.clear();
    peerCache.clear();
    pendingLogins.clear();
    await loadSavedClients(io);
  }
};
