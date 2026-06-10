import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { io } from "socket.io-client";
import {
  Bell,
  Download,
  ExternalLink,
  LogOut,
  MessageSquare,
  Moon,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  Shield,
  Sun,
  ArrowLeft,
  UserRound,
  Users,
  X
} from "lucide-react";
import { api, appLogin, getToken, setToken as saveToken } from "./api";
import "./styles/app.css";

function cx(...items) {
  return items.filter(Boolean).join(" ");
}

function formatTime(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function normalizeLink(value) {
  if (value.startsWith("@")) return `https://t.me/${value.slice(1)}`;
  if (value.startsWith("t.me/")) return `https://${value}`;
  return value;
}

function avatarUrl(accountId, peerId) {
  if (!accountId) return "";
  const path = peerId ? `/api/avatar/${accountId}/${encodeURIComponent(peerId)}` : `/api/avatar/${accountId}`;
  return `${path}?token=${encodeURIComponent(getToken())}`;
}

function Avatar({ accountId, peerId, label, size = 40 }) {
  const [failed, setFailed] = useState(false);
  const initials = (label || "?").trim().slice(0, 1).toUpperCase();
  if (!accountId || failed) {
    return <span className="avatar" style={{ height: size, width: size }}>{initials || <UserRound size={18} />}</span>;
  }
  return (
    <span className="avatar avatar-image" style={{ height: size, width: size }}>
      <img src={avatarUrl(accountId, peerId)} alt={label || "avatar"} loading="lazy" onError={() => setFailed(true)} />
    </span>
  );
}

function LinkAnchor({ href, children, onOpenLink }) {
  const normalized = normalizeLink(href);
  return (
    <a
      href={normalized}
      onClick={(event) => {
        if (!onOpenLink) return;
        event.preventDefault();
        onOpenLink(normalized);
      }}
      target="_blank"
      rel="noreferrer"
    >
      {children}<ExternalLink size={12} />
    </a>
  );
}

function renderPlainLinks(text, keyPrefix, onOpenLink) {
  const pattern = /(https?:\/\/[^\s]+|tg:\/\/[^\s]+|t\.me\/[^\s]+|@[A-Za-z0-9_]{5,32})/g;
  const parts = text.split(pattern);
  return parts.map((part, index) => {
    if (!part.match(pattern)) return <React.Fragment key={`${keyPrefix}-plain-${index}`}>{part}</React.Fragment>;
    const trailing = part.match(/[，。！？、；：,.!?;:)）】]+$/)?.[0] || "";
    const clean = trailing ? part.slice(0, -trailing.length) : part;
    return (
      <React.Fragment key={`${keyPrefix}-link-${index}`}>
        <LinkAnchor href={clean} onOpenLink={onOpenLink}>{clean}</LinkAnchor>
        {trailing}
      </React.Fragment>
    );
  });
}

function MessageText({ text, entities = [], onOpenLink }) {
  if (!text) return null;
  const links = entities
    .filter((entity) => entity.url && Number(entity.length) > 0)
    .sort((a, b) => a.offset - b.offset);
  const rendered = [];
  let cursor = 0;
  links.forEach((entity, index) => {
    const start = Number(entity.offset);
    const end = start + Number(entity.length);
    if (start < cursor || start > text.length) return;
    if (start > cursor) rendered.push(...renderPlainLinks(text.slice(cursor, start), `pre-${index}`, onOpenLink));
    const label = text.slice(start, Math.min(end, text.length));
    rendered.push(<LinkAnchor key={`entity-${index}`} href={entity.url} onOpenLink={onOpenLink}>{label}</LinkAnchor>);
    cursor = Math.min(end, text.length);
  });
  if (cursor < text.length) rendered.push(...renderPlainLinks(text.slice(cursor), "tail", onOpenLink));
  return (
    <p className="message-text">
      {rendered}
    </p>
  );
}

function mediaUrl(accountId, chatId, messageId, inline = false) {
  const params = new URLSearchParams({ token: getToken() });
  if (inline) params.set("inline", "1");
  return `/api/media/${accountId}/${encodeURIComponent(chatId)}/${messageId}?${params.toString()}`;
}

function MessageMedia({ accountId, chatId, message }) {
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState(false);
  const media = message.media;
  if (!media) return null;
  const previewUrl = mediaUrl(accountId, chatId, message.id, true);
  const downloadUrl = mediaUrl(accountId, chatId, message.id);
  const label = media.fileName || media.mimeType || "下载媒体";
  if (media.kind === "image") {
    return (
      <a className="media-preview image-preview" href={downloadUrl} target="_blank" rel="noreferrer" title="打开原图">
        <img src={previewUrl} alt={label} loading="lazy" />
      </a>
    );
  }
  if (media.kind === "video") {
    const ratio = media.width && media.height ? `${media.width} / ${media.height}` : "16 / 9";
    const orientation = Number(media.height || 0) > Number(media.width || 0) ? "portrait" : "landscape";
    return (
      <div className={cx("media-preview", "video-preview", orientation)} style={{ "--video-ratio": ratio }}>
        {!active && !failed ? <button className="video-load-button" type="button" onClick={() => setActive(true)}>点击播放视频</button> : null}
        {active && !failed ? <video controls autoPlay preload="auto" playsInline onError={() => setFailed(true)}>
          <source src={previewUrl} type={media.mimeType || "video/mp4"} />
        </video> : null}
        {failed ? <div className="video-fallback">当前浏览器无法直接播放这个视频格式，请下载后播放。</div> : null}
        <a className="media-chip" href={downloadUrl} target="_blank" rel="noreferrer"><Download size={15} />{label}</a>
      </div>
    );
  }
  return <a className="media-chip" href={downloadUrl} target="_blank" rel="noreferrer"><Download size={15} />{label}</a>;
}

function useSocket(token) {
  return useMemo(() => token ? io("/", { auth: { token } }) : null, [token]);
}

function AuthGate({ onReady }) {
  const [mode, setMode] = useState("checking");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api("/api/bootstrap/status")
      .then((state) => setMode(state.required ? "bootstrap" : "login"))
      .catch(() => setMode("login"));
  }, []);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const endpoint = mode === "bootstrap" ? "/api/bootstrap" : "/api/login";
      const result = mode === "bootstrap"
        ? await api(endpoint, { method: "POST", body: JSON.stringify({ username, password }) })
        : await appLogin({ username, password });
      saveToken(result.token);
      onReady(result.token, result.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (mode === "checking") return <main className="auth-page"><div className="auth-panel">加载中</div></main>;

  return (
    <main className="auth-page">
      <form className="auth-panel" onSubmit={submit}>
        <div className="brand-row">
          <div className="brand-mark"><MessageSquare size={24} /></div>
          <div>
            <h1>Feigram</h1>
            <p>{mode === "bootstrap" ? "创建第一个管理员" : "公开版登录"}</p>
          </div>
        </div>
        <label><span>飞牛账户</span><input autoFocus value={username} onChange={(e) => setUsername(e.target.value)} required /></label>
        <label><span>密码</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required /></label>
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy}><Shield size={18} />{busy ? "处理中" : mode === "bootstrap" ? "创建管理员" : "登录"}</button>
      </form>
    </main>
  );
}

function AccountLogin({ socket, onDone }) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState("phone");
  const [label, setLabel] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [loginId, setLoginId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function call(event, payload) {
    return new Promise((resolve, reject) => {
      if (!socket?.connected) {
        reject(new Error("实时连接未建立，请刷新页面后重试"));
        return;
      }
      socket.timeout(20000).emit(event, payload, (err, reply) => {
        if (err) {
          reject(new Error("请求超时，请检查 Telegram API 配置、网络或稍后重试"));
          return;
        }
        reply?.ok ? resolve(reply.data) : reject(new Error(reply?.error || "操作失败"));
      });
    });
  }

  async function start(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const data = await call("login:start", { label, phoneNumber });
      setLoginId(data.loginId);
      setStep("code");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const data = await call("login:code", { loginId, code });
      if (data.passwordRequired) setStep("password");
      else {
        setOpen(false);
        onDone(data.account);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function submitPassword(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const data = await call("login:password", { loginId, password });
      setOpen(false);
      onDone(data.account);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!open) return <button className="secondary action-button" onClick={() => setOpen(true)} title="添加 Telegram 账号"><Plus size={18} />添加 Telegram 账号</button>;

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <button className="close" onClick={() => setOpen(false)} title="关闭"><X size={18} /></button>
        <h2>登录 Telegram</h2>
        {step === "phone" && <form onSubmit={start} className="stack">
          <label><span>账号名称</span><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="我的账号" /></label>
          <label><span>手机号</span><input value={phoneNumber} onChange={(e) => setPhoneNumber(e.target.value)} placeholder="+86..." required /></label>
          <button className="primary" disabled={busy}><Send size={18} />{busy ? "发送中" : "发送验证码"}</button>
        </form>}
        {step === "code" && <form onSubmit={submitCode} className="stack">
          <label><span>验证码</span><input value={code} onChange={(e) => setCode(e.target.value)} required /></label>
          <button className="primary" disabled={busy}><Send size={18} />{busy ? "验证中" : "完成登录"}</button>
        </form>}
        {step === "password" && <form onSubmit={submitPassword} className="stack">
          <label><span>两步验证密码</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
          <button className="primary" disabled={busy}><Shield size={18} />{busy ? "验证中" : "验证密码"}</button>
        </form>}
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}

function AdminPanel({ accounts, accountId, canAdmin, onAccountChange, onAccountLogout, onAccountsChanged, open, onClose, initialTab = "accounts", socket }) {
  const [tab, setTab] = useState(initialTab);
  const [users, setUsers] = useState([]);
  const [settings, setSettings] = useState({
    publicBaseUrl: "",
    telegramApiId: "",
    telegramApiHash: "",
    cacheBaseDir: "",
    imageCacheDir: "",
    videoCacheDir: "",
    fileCacheDir: "",
    cacheRetentionDays: "30"
  });
  const [apiIdPlaceholder, setApiIdPlaceholder] = useState("");
  const [hashPlaceholder, setHashPlaceholder] = useState("");
  const [newUser, setNewUser] = useState({ username: "", password: "", displayName: "", role: "user" });
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  useEffect(() => {
    if (!open) return;
    setTab(initialTab);
    refresh();
  }, [open, initialTab]);

  async function refresh() {
    setError("");
    if (canAdmin) {
      setUsers(await api("/api/admin/users").catch((err) => { setError(err.message); return []; }));
      const nextSettings = await api("/api/settings").catch(() => ({}));
      setSettings({
        publicBaseUrl: nextSettings.publicBaseUrl || "",
        telegramApiId: "",
        telegramApiHash: "",
        cacheBaseDir: nextSettings.cacheBaseDir || "",
        imageCacheDir: nextSettings.imageCacheDir || "",
        videoCacheDir: nextSettings.videoCacheDir || "",
        fileCacheDir: nextSettings.fileCacheDir || "",
        cacheRetentionDays: nextSettings.cacheRetentionDays || "30"
      });
      setApiIdPlaceholder(nextSettings.telegramApiIdSet ? "已保存，留空则不修改" : "请输入 Telegram API ID");
      setHashPlaceholder(nextSettings.telegramApiHashSet ? "已保存，留空则不修改" : "请输入 Telegram API Hash");
    }
  }

  async function createUser(event) {
    event.preventDefault();
    setError("");
    try {
      await api("/api/admin/users", { method: "POST", body: JSON.stringify(newUser) });
      setNewUser({ username: "", password: "", displayName: "", role: "user" });
      refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  async function updateUser(user, patch) {
    setError("");
    try {
      await api(`/api/admin/users/${user.id}`, { method: "PUT", body: JSON.stringify({ ...user, ...patch }) });
      refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  async function saveSettings(event) {
    event.preventDefault();
    setSaved("");
    setError("");
    try {
      const payload = { ...settings };
      if (!payload.telegramApiId) delete payload.telegramApiId;
      if (!payload.telegramApiHash) delete payload.telegramApiHash;
      await api("/api/settings", { method: "PUT", body: JSON.stringify(payload) });
      setSaved("已保存");
      refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  if (!open) return null;

  return (
    <div className="modal-backdrop">
      <div className="modal admin-modal">
        <button className="close" onClick={onClose} title="关闭"><X size={18} /></button>
        <h2>{canAdmin ? "管理员后台" : "账号后台"}</h2>
        <div className="tabs">
          <button className={cx(tab === "accounts" && "active")} onClick={() => setTab("accounts")}>Telegram 账号</button>
          {canAdmin && <button className={cx(tab === "users" && "active")} onClick={() => setTab("users")}>飞牛账户</button>}
          {canAdmin && <button className={cx(tab === "settings" && "active")} onClick={() => setTab("settings")}>覆盖 API 设置</button>}
          {canAdmin && <button className={cx(tab === "cache" && "active")} onClick={() => setTab("cache")}>缓存下载</button>}
        </div>
        {error && <p className="error">{error}</p>}
        {tab === "accounts" && <div className="account-admin">
          <div className="account-admin-head">
            {socket && <AccountLogin socket={socket} onDone={() => onAccountsChanged?.()} />}
          </div>
          <div className="account-admin-list">
            {accounts.map((account) => <div className="account-admin-row" key={account.id}>
              <Avatar accountId={account.id} label={account.displayName || account.label} size={38} />
              <div>
                <strong>{account.displayName || account.label}</strong>
                <span>{account.username ? `@${account.username}` : account.phoneNumber || "Telegram 账号"}</span>
              </div>
              <button className="icon-button" onClick={() => onAccountChange(account.id)}>{account.id === accountId ? "当前" : "切换"}</button>
              <button className="icon-button danger-button" onClick={() => onAccountLogout(account.id)}><LogOut size={16} />退出</button>
            </div>)}
            {!accounts.length && <div className="empty">暂无 Telegram 账号</div>}
          </div>
        </div>}
        {canAdmin && tab === "users" && <>
          <form className="admin-grid" onSubmit={createUser}>
            <input placeholder="飞牛账户" value={newUser.username} onChange={(e) => setNewUser({ ...newUser, username: e.target.value })} required />
            <input placeholder="显示名" value={newUser.displayName} onChange={(e) => setNewUser({ ...newUser, displayName: e.target.value })} />
            <input placeholder="初始密码" type="password" value={newUser.password} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} minLength={8} required />
            <select value={newUser.role} onChange={(e) => setNewUser({ ...newUser, role: e.target.value })}><option value="user">user</option><option value="admin">admin</option></select>
            <button className="primary"><Plus size={16} />创建</button>
          </form>
          <div className="user-list">
            {users.map((user) => <div className="user-row" key={user.id}>
              <strong>{user.displayName}</strong>
              <span>{user.username}</span>
              <span>{user.role}</span>
              <button className="icon-button" onClick={() => updateUser(user, { disabled: !user.disabled })}>{user.disabled ? "启用" : "禁用"}</button>
              <button className="icon-button" onClick={() => {
                const password = prompt("输入新密码，至少 8 位");
                if (password) updateUser(user, { password });
              }}>重置密码</button>
            </div>)}
          </div>
        </>}
        {canAdmin && tab === "settings" && <form className="stack" onSubmit={saveSettings}>
          <label><span>公开访问地址</span><input value={settings.publicBaseUrl} onChange={(e) => setSettings({ ...settings, publicBaseUrl: e.target.value })} placeholder="https://feigram.example.com" required /></label>
          <label><span>Telegram API ID</span><input type="password" inputMode="numeric" autoComplete="off" value={settings.telegramApiId} onChange={(e) => setSettings({ ...settings, telegramApiId: e.target.value })} placeholder={apiIdPlaceholder} /></label>
          <label><span>Telegram API Hash</span><input type="password" value={settings.telegramApiHash} onChange={(e) => setSettings({ ...settings, telegramApiHash: e.target.value })} placeholder={hashPlaceholder} /></label>
          {saved && <p className="success">{saved}</p>}
          <button className="primary"><Settings size={18} />保存</button>
        </form>}
        {canAdmin && tab === "cache" && <form className="stack" onSubmit={saveSettings}>
          <label><span>基础缓存下载位置</span><input value={settings.cacheBaseDir} onChange={(e) => setSettings({ ...settings, cacheBaseDir: e.target.value })} placeholder="/data/downloads" required /></label>
          <label><span>图片缓存位置</span><input value={settings.imageCacheDir} onChange={(e) => setSettings({ ...settings, imageCacheDir: e.target.value })} placeholder="留空则使用 基础缓存/images" /></label>
          <label><span>视频缓存位置</span><input value={settings.videoCacheDir} onChange={(e) => setSettings({ ...settings, videoCacheDir: e.target.value })} placeholder="留空则使用 基础缓存/videos" /></label>
          <label><span>文件缓存位置</span><input value={settings.fileCacheDir} onChange={(e) => setSettings({ ...settings, fileCacheDir: e.target.value })} placeholder="留空则使用 基础缓存/files" /></label>
          <label><span>聊天缓存自动清除天数</span><input type="number" min="1" max="3650" value={settings.cacheRetentionDays} onChange={(e) => setSettings({ ...settings, cacheRetentionDays: e.target.value })} required /></label>
          {saved && <p className="success">{saved}</p>}
          <button className="primary"><Settings size={18} />保存缓存设置</button>
        </form>}
      </div>
    </div>
  );
}

function InfoModal({ announcements, about, open, onClose }) {
  if (!open) return null;
  return (
    <div className="modal-backdrop">
      <div className="modal announcement-modal">
        <button className="close" onClick={onClose} title="关闭"><X size={18} /></button>
        <h2>公告</h2>
        <div className="announcement-list">
          {announcements.map((item) => <article className="announcement-item" key={item.id}>
            <strong>{item.title}</strong>
            <span>{item.version ? `v${item.version} · ` : ""}{formatTime(item.createdAt)}</span>
            <p>{item.body}</p>
          </article>)}
          {!announcements.length && <div className="empty">暂无公告</div>}
          <article className="announcement-item about-item">
            <strong>{about?.title || "关于 Feigram"}</strong>
            <p>{about?.body || "Feigram 是第三方开发的非官方 Telegram 客户端。"}</p>
            {about?.releaseUrl && <a href={about.releaseUrl} target="_blank" rel="noreferrer">发布仓库</a>}
            {about?.privacyPolicyUrl && <a href={about.privacyPolicyUrl} target="_blank" rel="noreferrer">隐私政策</a>}
            {about?.termsUrl && <a href={about.termsUrl} target="_blank" rel="noreferrer">服务条款</a>}
            {about?.supportEmail && <a href={`mailto:${about.supportEmail}`}>支持邮箱</a>}
          </article>
        </div>
      </div>
    </div>
  );
}

function App() {
  const [token, setTokenState] = useState(getToken());
  const [me, setMe] = useState(null);
  const [theme, setTheme] = useState(localStorage.getItem("feigrame.theme") || "dark");
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState("");
  const [chats, setChats] = useState([]);
  const [folders, setFolders] = useState([]);
  const [activeFolder, setActiveFolder] = useState("all");
  const [activeChat, setActiveChat] = useState(null);
  const [chatStack, setChatStack] = useState([]);
  const [messages, setMessages] = useState([]);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [adminOpen, setAdminOpen] = useState(false);
  const [adminInitialTab, setAdminInitialTab] = useState("accounts");
  const [notifications, setNotifications] = useState("Notification" in window && Notification.permission === "granted");
  const [announcements, setAnnouncements] = useState([]);
  const [about, setAbout] = useState({});
  const [announcementOpen, setAnnouncementOpen] = useState(false);
  const socket = useSocket(token);
  const messagesRef = useRef(null);
  const activeAccount = accounts.find((account) => account.id === accountId);
  const newestAnnouncementId = announcements[0]?.id || "";
  const unreadAnnouncement = newestAnnouncementId && localStorage.getItem("feigrame.lastAnnouncement") !== newestAnnouncementId;
  const visibleChats = useMemo(() => {
    const folder = folders.find((item) => String(item.id) === String(activeFolder));
    if (!folder) return chats;
    const include = new Set([...(folder.includePeerIds || []), ...(folder.pinnedPeerIds || [])]);
    const exclude = new Set(folder.excludePeerIds || []);
    return chats.filter((chat) => {
      if (exclude.has(chat.id)) return false;
      if ((chat.folderIds || []).some((id) => String(id) === String(folder.id))) return true;
      if (include.has(chat.id)) return true;
      const flags = folder.flags || {};
      if (chat.type === "group" && flags.groups) return true;
      if (chat.type === "channel" && flags.broadcasts) return true;
      if (chat.type === "private" && (flags.contacts || flags.nonContacts || flags.bots)) return true;
      return include.size === 0 && !flags.groups && !flags.broadcasts && !flags.contacts && !flags.nonContacts && !flags.bots;
    });
  }, [chats, folders, activeFolder]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("feigrame.theme", theme);
  }, [theme]);

  useEffect(() => {
    if (!token) return;
    api("/api/me").then(setMe).catch(() => setTokenState(""));
    loadAnnouncements();
    loadAbout();
    refreshAccounts();
  }, [token]);

  useEffect(() => {
    if (!accountId) return;
    socket?.emit("account:join", accountId);
    loadFolders();
    loadChats();
  }, [accountId, socket]);

  useEffect(() => {
    if (!socket) return;
    const handler = ({ accountId: incomingAccount, message }) => {
      if (incomingAccount !== accountId) return;
      if (notifications && !message.outgoing && message.text) new Notification("Feigram 新消息", { body: message.text.slice(0, 120) });
      setMessages((current) => [...current, message]);
    };
    socket.on("message:new", handler);
    return () => socket.off("message:new", handler);
  }, [socket, accountId, notifications]);

  useEffect(() => {
    const element = messagesRef.current;
    if (element && !loadingOlder) element.scrollTop = element.scrollHeight;
  }, [activeChat?.id, messages.length, loadingOlder]);

  async function refreshAccounts(preferFirst = false) {
    setError("");
    const list = await api("/api/accounts").catch((err) => { setError(err.message); return []; });
    setAccounts(list);
    if ((preferFirst || !accountId) && list[0]) setAccountId(list[0].id);
    if (!list.length) setAccountId("");
  }

  async function loadChats(nextQuery = query) {
    if (!accountId) return;
    setBusy(true);
    setError("");
    try {
      const list = await api(`/api/chats?account=${encodeURIComponent(accountId)}&query=${encodeURIComponent(nextQuery)}`);
      setChats(list);
      if (!activeChat && list[0]) selectChat(list[0]);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function loadFolders() {
    if (!accountId) return;
    const list = await api(`/api/folders?account=${encodeURIComponent(accountId)}`).catch(() => []);
    setFolders(list);
    setActiveFolder("all");
  }

  async function selectChat(chat) {
    setActiveChat(chat);
    setBusy(true);
    try {
      const list = await api(`/api/messages?account=${encodeURIComponent(accountId)}&peer=${encodeURIComponent(chat.id)}&limit=80`);
      setMessages(list);
      setHasOlder(list.length >= 80);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function returnToPreviousChat() {
    const previous = chatStack[chatStack.length - 1];
    if (!previous) return;
    setChatStack((current) => current.slice(0, -1));
    await selectChat(previous);
  }

  async function reloadActiveMessages() {
    if (!activeChat) return;
    const list = await api(`/api/messages?account=${encodeURIComponent(accountId)}&peer=${encodeURIComponent(activeChat.id)}&limit=80`);
    setMessages(list);
    setHasOlder(list.length >= 80);
  }

  async function loadOlderMessages() {
    if (!activeChat || !messages.length) return;
    const firstId = messages[0].id;
    const element = messagesRef.current;
    const previousHeight = element?.scrollHeight || 0;
    setLoadingOlder(true);
    setError("");
    try {
      const older = await api(`/api/messages?account=${encodeURIComponent(accountId)}&peer=${encodeURIComponent(activeChat.id)}&limit=80&before=${encodeURIComponent(firstId)}`);
      setMessages((current) => [...older, ...current]);
      setHasOlder(older.length >= 80);
      requestAnimationFrame(() => {
        if (element) element.scrollTop = element.scrollHeight - previousHeight;
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingOlder(false);
    }
  }

  function notify(message) {
    setToast(message);
    window.clearTimeout(notify.timer);
    notify.timer = window.setTimeout(() => setToast(""), 4200);
  }

  async function logoutAccount(targetAccountId = accountId) {
    if (!targetAccountId || !confirm("确定退出这个 Telegram 账号？")) return;
    setError("");
    try {
      await api(`/api/accounts/${encodeURIComponent(targetAccountId)}`, { method: "DELETE" });
      if (targetAccountId === accountId) {
        setAccountId("");
        setActiveChat(null);
        setMessages([]);
      }
      await refreshAccounts(true);
    } catch (err) {
      notify(err.message);
    }
  }

  async function openTelegramLink(url) {
    const normalized = normalizeLink(url);
    if (!accountId) {
      window.open(normalized, "_blank", "noopener,noreferrer");
      return;
    }
    try {
      const chat = await api("/api/resolve-link", {
        method: "POST",
        body: JSON.stringify({ account: accountId, url: normalized })
      });
      setChats((current) => current.some((item) => item.id === chat.id) ? current : [chat, ...current]);
      if (activeChat && activeChat.id !== chat.id) {
        setChatStack((current) => [...current, activeChat].slice(-12));
      }
      await selectChat(chat);
    } catch {
      window.open(normalized, "_blank", "noopener,noreferrer");
    }
  }

  async function clickInlineButton(message, button) {
    if (button.url) {
      openTelegramLink(button.url);
      return;
    }
    if (!button.data) return;
    setError("");
    try {
      const result = await api("/api/messages/callback", {
        method: "POST",
        body: JSON.stringify({
          account: accountId,
          peer: activeChat.id,
          messageId: message.id,
          data: button.data
        })
      });
      if (result.url) openTelegramLink(result.url);
      if (result.message) notify(result.message);
      setTimeout(() => reloadActiveMessages().catch((err) => setError(err.message)), 600);
    } catch (err) {
      notify(err.message.replace(/^RPC_/, ""));
    }
  }

  async function sendMessage(event) {
    event.preventDefault();
    if (!draft.trim() || !activeChat) return;
    const text = draft.trim();
    setDraft("");
    try {
      const sent = await api("/api/messages", { method: "POST", body: JSON.stringify({ account: accountId, peer: activeChat.id, text }) });
      setMessages((current) => [...current, sent]);
    } catch (err) {
      setError(err.message);
      setDraft(text);
    }
  }

  async function enableNotifications() {
    if ("Notification" in window && Notification.permission !== "granted") {
      setNotifications(await Notification.requestPermission() === "granted");
    }
    if (newestAnnouncementId) localStorage.setItem("feigrame.lastAnnouncement", newestAnnouncementId);
    setAnnouncementOpen(true);
  }

  async function loadAnnouncements() {
    const list = await api("/api/announcements").catch(() => []);
    setAnnouncements(list);
  }

  async function loadAbout() {
    const info = await api("/api/about").catch(() => ({}));
    setAbout(info);
  }

  if (!token) return <AuthGate onReady={(nextToken, user) => { setTokenState(nextToken); setMe(user); }} />;

  return (
    <main className={cx("app-shell", activeChat && "chat-open")}>
      {toast && <div className="toast-banner">{toast}</div>}
      <aside className="sidebar">
        <div className="topbar">
          <div className="brand-compact"><MessageSquare size={20} /> Feigram</div>
          <div className="tools">
            <button className="icon-button" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} title="切换主题">{theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}</button>
            <button className={cx("icon-button", unreadAnnouncement && "has-notice")} onClick={enableNotifications} title="通知与公告"><Bell size={18} /></button>
            <button className="icon-button" onClick={() => { setAdminInitialTab("accounts"); setAdminOpen(true); }} title={me?.role === "admin" ? "管理员后台" : "账号后台"}><Users size={18} /></button>
          </div>
        </div>
        <div className="account-row current-account-row">
          {activeAccount ? <>
            <Avatar accountId={activeAccount.id} label={activeAccount.displayName || activeAccount.label} size={40} />
            <div className="current-account-copy">
              <strong>{activeAccount.displayName || activeAccount.label}</strong>
              <span>{activeAccount.username ? `@${activeAccount.username}` : activeAccount.phoneNumber || "Telegram"}</span>
            </div>
            {accounts.length > 1 && <select value={accountId} onChange={(event) => {
              setAccountId(event.target.value);
              setActiveChat(null);
              setChatStack([]);
              setMessages([]);
            }} title="切换 Telegram 账号">
              {accounts.map((account) => <option key={account.id} value={account.id}>{account.displayName || account.label}</option>)}
            </select>}
          </> : <button className="secondary action-button" onClick={() => { setAdminInitialTab("accounts"); setAdminOpen(true); }}><Plus size={18} />添加 Telegram 账号</button>}
        </div>
        {!!folders.length && <div className="folder-tabs">
          <button className={cx(activeFolder === "all" && "active")} onClick={() => setActiveFolder("all")}>全部</button>
          {folders.map((folder) => <button key={folder.id} className={cx(String(activeFolder) === String(folder.id) && "active")} onClick={() => setActiveFolder(folder.id)}>
            {folder.emoticon ? `${folder.emoticon} ` : ""}{folder.title}
          </button>)}
        </div>}
        <form className="search" onSubmit={(event) => { event.preventDefault(); loadChats(query); }}>
          <Search size={17} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索私聊、群组、频道" />
          <button title="搜索"><RefreshCw size={16} /></button>
        </form>
        <div className="chat-list">
          {visibleChats.map((chat) => <button key={chat.id} className={cx("chat-item", activeChat?.id === chat.id && "active")} onClick={() => selectChat(chat)}>
            <Avatar accountId={accountId} peerId={chat.id} label={chat.title} />
            <span className="chat-copy"><strong>{chat.title}</strong><small>{chat.lastMessage?.text || chat.type}</small></span>
            {chat.unreadCount > 0 && <span className="badge">{chat.unreadCount}</span>}
          </button>)}
          {!visibleChats.length && <div className="empty">暂无会话</div>}
        </div>
      </aside>
      <section className="conversation">
        {activeChat ? <>
          <header className="conversation-head">
            <button className={cx("icon-button", chatStack.length ? "nav-back-button" : "back-button")} onClick={chatStack.length ? returnToPreviousChat : () => setActiveChat(null)} title={chatStack.length ? "返回上层位置" : "返回会话列表"}><ArrowLeft size={18} /></button>
            <div><h2>{activeChat.title}</h2><p>{activeChat.type} {activeChat.username ? `@${activeChat.username}` : ""}</p></div>
          </header>
          {error && <p className="error inline">{error}</p>}
          <div className="messages" ref={messagesRef}>
            {hasOlder && <button className="history-button" onClick={loadOlderMessages} disabled={loadingOlder}>{loadingOlder ? "加载中" : "加载更早消息"}</button>}
            {messages.map((message) => <article key={`${message.id}-${message.date}`} className={cx("bubble", message.outgoing && "mine")}>
              <MessageText text={message.text} entities={message.entities} onOpenLink={openTelegramLink} />
              <MessageMedia accountId={accountId} chatId={activeChat.id} message={message} />
              {!!message.buttons?.length && <div className="inline-buttons">
                {message.buttons.map((row, rowIndex) => <div className="inline-button-row" key={`${message.id}-row-${rowIndex}`}>
                  {row.map((button, buttonIndex) => <button type="button" key={`${button.text}-${buttonIndex}`} onClick={() => clickInlineButton(message, button)} disabled={button.type === "unsupported"}>
                    {button.text || "按钮"}
                  </button>)}
                </div>)}
              </div>}
              <time>{formatTime(message.date)}</time>
            </article>)}
            {busy && <div className="empty">加载中</div>}
          </div>
          <form className="composer" onSubmit={sendMessage}><textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              sendMessage(event);
            }
          }} placeholder="输入消息" rows={1} /><button className="primary" title="发送"><Send size={18} /></button></form>
        </> : <div className="blank-state"><MessageSquare size={40} /><h2>选择或添加一个 Telegram 账号</h2></div>}
      </section>
      <AdminPanel
        accounts={accounts}
        accountId={accountId}
        canAdmin={me?.role === "admin"}
        onAccountChange={(nextId) => {
          setAccountId(nextId);
          setActiveChat(null);
          setChatStack([]);
          setMessages([]);
          setAdminOpen(false);
        }}
        onAccountLogout={logoutAccount}
        onAccountsChanged={() => refreshAccounts(true)}
        open={adminOpen}
        initialTab={adminInitialTab}
        onClose={() => setAdminOpen(false)}
        socket={socket}
      />
      <InfoModal announcements={announcements} about={about} open={announcementOpen} onClose={() => setAnnouncementOpen(false)} />
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
