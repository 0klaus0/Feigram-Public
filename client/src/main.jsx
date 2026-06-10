import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { io } from "socket.io-client";
import {
  Bell,
  Download,
  ExternalLink,
  Folder,
  LogOut,
  MessageSquare,
  Moon,
  Play,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  Shield,
  SlidersHorizontal,
  Sun,
  ArrowLeft,
  Trash2,
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

function formatBytes(value) {
  const size = Number(value || 0);
  if (!size) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(size) / Math.log(1024)));
  return `${(size / (1024 ** index)).toFixed(index ? 1 : 0)} ${units[index]}`;
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

function MessageMedia({ accountId, chatId, message, compact = false, onCache, task }) {
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState(false);
  const [localStatus, setLocalStatus] = useState("");
  const media = message.media;
  if (!media) return null;
  const previewUrl = mediaUrl(accountId, chatId, message.id, true);
  const downloadUrl = mediaUrl(accountId, chatId, message.id);
  const label = media.fileName || media.mimeType || "下载媒体";
  const cacheStatus = task?.status || localStatus;
  const cacheLabel = cacheStatus === "completed" ? "已缓存" : cacheStatus === "downloading" ? "下载中" : cacheStatus === "queued" ? "排队中" : cacheStatus === "cancelled" ? "继续缓存" : "缓存";
  if (media.kind === "image") {
    return (
      <a className={cx("media-preview image-preview", compact && "compact-media")} href={previewUrl} target="_blank" rel="noreferrer" title="打开原图">
        <img src={previewUrl} alt={label} loading="lazy" />
      </a>
    );
  }
  if (media.kind === "video") {
    const ratio = media.width && media.height ? `${media.width} / ${media.height}` : "16 / 9";
    const orientation = Number(media.height || 0) > Number(media.width || 0) ? "portrait" : "landscape";
    return (
      <div className={cx("media-preview", "video-preview", orientation, compact && "compact-media")} style={{ "--video-ratio": ratio }}>
        <div className="video-stage">
          <button
            className={cx("video-cache-button", cacheStatus === "completed" && "done", cacheStatus === "downloading" && "busy")}
            type="button"
            disabled={cacheStatus === "downloading" || cacheStatus === "queued"}
            onClick={async (event) => {
              event.stopPropagation();
              setLocalStatus("queued");
              try {
                const result = await onCache?.(message);
                setLocalStatus(result?.status || "queued");
                setFailed(false);
              } catch {
                setLocalStatus("");
              }
            }}
            title={cacheStatus === "completed" ? "已缓存到下载目录" : "缓存视频到下载列表"}
          >
            <Download size={14} />{cacheLabel}
          </button>
          {!active && !failed ? <button className="video-load-button" type="button" onClick={() => setActive(true)}>点击播放视频</button> : null}
          {active && !failed ? <video src={previewUrl} controls autoPlay preload="metadata" playsInline onError={() => setFailed(true)} /> : null}
          {failed ? <div className="video-fallback">这个视频编码当前内置播放器无法直接解码，可先缓存后用本地播放器打开。</div> : null}
        </div>
      </div>
    );
  }
  return <a className="media-chip" href={downloadUrl}><Download size={15} />{label}</a>;
}

function buildMessageItems(messages) {
  const items = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.groupedId && message.media) {
      const group = [message];
      while (index + 1 < messages.length && messages[index + 1].groupedId === message.groupedId && messages[index + 1].media) {
        group.push(messages[index + 1]);
        index += 1;
      }
      items.push({ type: "group", id: `group-${message.groupedId}-${message.id}`, messages: group });
    } else {
      items.push({ type: "message", id: `${message.id}-${message.date}`, message });
    }
  }
  return items;
}

function MessageBubble({ item, accountId, chatId, showSender, showMedia, onOpenLink, onInlineButton, onCacheMedia, downloadTasks }) {
  const messages = item.type === "group" ? item.messages : [item.message];
  const first = messages[0];
  const caption = messages.find((message) => message.text) || first;
  const taskFor = (message) => downloadTasks.find((task) => (
    task.accountId === accountId && task.peerId === chatId && Number(task.messageId) === Number(message.id)
  ));
  return (
    <article className={cx("message-row", first.outgoing && "mine")}>
      {showSender && !first.outgoing && <Avatar accountId={accountId} peerId={first.sender?.id} label={first.sender?.title || first.senderId} size={34} />}
      <div className={cx("bubble", first.outgoing && "mine", item.type === "group" && "media-group-bubble")}>
        {showSender && !first.outgoing && <div className="sender-line">{first.sender?.title || first.senderId}<span>{first.sender?.username ? `@${first.sender.username}` : first.senderId}</span></div>}
        {caption.text && <MessageText text={caption.text} entities={caption.entities} onOpenLink={onOpenLink} />}
        {showMedia && item.type === "group" ? <div className={cx("media-grid", messages.length > 1 && "multi")}>
          {messages.map((message) => <MessageMedia key={message.id} accountId={accountId} chatId={chatId} message={message} compact onCache={onCacheMedia} task={taskFor(message)} />)}
        </div> : showMedia && <MessageMedia accountId={accountId} chatId={chatId} message={first} onCache={onCacheMedia} task={taskFor(first)} />}
        {!!caption.buttons?.length && <div className="inline-buttons">
          {caption.buttons.map((row, rowIndex) => <div className="inline-button-row" key={`${caption.id}-row-${rowIndex}`}>
            {row.map((button, buttonIndex) => <button type="button" key={`${button.text}-${buttonIndex}`} onClick={() => onInlineButton(caption, button)} disabled={button.type === "unsupported"}>
              {button.text || "按钮"}
            </button>)}
          </div>)}
        </div>}
        <time>{formatTime(messages[messages.length - 1].date)}</time>
      </div>
    </article>
  );
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

function AdminPanel({ accounts, accountId, canAdmin, onAccountChange, onAccountLogout, onAccountsChanged, onSettingsChanged, open, onClose, initialTab = "accounts", socket }) {
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
    cacheRetentionDays: "30",
    notificationEnabled: true,
    notificationPreview: true,
    privacyOpenTelegramLinksInApp: true,
    privacyMediaPreview: true,
    messageShowSender: true,
    foldersEnabled: true,
    foldersShowArchived: false,
    foldersAutoSelectFirst: true
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
        cacheRetentionDays: nextSettings.cacheRetentionDays || "30",
        notificationEnabled: nextSettings.notificationEnabled !== false,
        notificationPreview: nextSettings.notificationPreview !== false,
        privacyOpenTelegramLinksInApp: nextSettings.privacyOpenTelegramLinksInApp !== false,
        privacyMediaPreview: nextSettings.privacyMediaPreview !== false,
        messageShowSender: nextSettings.messageShowSender !== false,
        foldersEnabled: nextSettings.foldersEnabled !== false,
        foldersShowArchived: Boolean(nextSettings.foldersShowArchived),
        foldersAutoSelectFirst: nextSettings.foldersAutoSelectFirst !== false
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
      onSettingsChanged?.();
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
          {canAdmin && <button className={cx(tab === "notifications" && "active")} onClick={() => setTab("notifications")}>通知</button>}
          {canAdmin && <button className={cx(tab === "privacy" && "active")} onClick={() => setTab("privacy")}>隐私</button>}
          {canAdmin && <button className={cx(tab === "folders" && "active")} onClick={() => setTab("folders")}>分组</button>}
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
        {canAdmin && tab === "notifications" && <form className="stack" onSubmit={saveSettings}>
          <label className="check-row"><input type="checkbox" checked={settings.notificationEnabled} onChange={(e) => setSettings({ ...settings, notificationEnabled: e.target.checked })} /><span>启用桌面通知</span></label>
          <label className="check-row"><input type="checkbox" checked={settings.notificationPreview} onChange={(e) => setSettings({ ...settings, notificationPreview: e.target.checked })} /><span>通知显示消息预览</span></label>
          {saved && <p className="success">{saved}</p>}
          <button className="primary"><Settings size={18} />保存通知设置</button>
        </form>}
        {canAdmin && tab === "privacy" && <form className="stack" onSubmit={saveSettings}>
          <label className="check-row"><input type="checkbox" checked={settings.privacyOpenTelegramLinksInApp} onChange={(e) => setSettings({ ...settings, privacyOpenTelegramLinksInApp: e.target.checked })} /><span>Telegram 链接优先在客户端内打开</span></label>
          <label className="check-row"><input type="checkbox" checked={settings.privacyMediaPreview} onChange={(e) => setSettings({ ...settings, privacyMediaPreview: e.target.checked })} /><span>聊天中显示图片和视频预览</span></label>
          <label className="check-row"><input type="checkbox" checked={settings.messageShowSender} onChange={(e) => setSettings({ ...settings, messageShowSender: e.target.checked })} /><span>群聊消息显示发言人头像和 ID</span></label>
          {saved && <p className="success">{saved}</p>}
          <button className="primary"><Settings size={18} />保存隐私设置</button>
        </form>}
        {canAdmin && tab === "folders" && <form className="stack" onSubmit={saveSettings}>
          <label className="check-row"><input type="checkbox" checked={settings.foldersEnabled} onChange={(e) => setSettings({ ...settings, foldersEnabled: e.target.checked })} /><span>同步 Telegram 聊天文件夹</span></label>
          <label className="check-row"><input type="checkbox" checked={settings.foldersShowArchived} onChange={(e) => setSettings({ ...settings, foldersShowArchived: e.target.checked })} /><span>会话列表显示归档会话</span></label>
          <label className="check-row"><input type="checkbox" checked={settings.foldersAutoSelectFirst} onChange={(e) => setSettings({ ...settings, foldersAutoSelectFirst: e.target.checked })} /><span>打开账号后自动选择第一个会话</span></label>
          {saved && <p className="success">{saved}</p>}
          <button className="primary"><Settings size={18} />保存分组设置</button>
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

function DownloadCenter({ open, downloads, onStart, onCancel, onDelete, onClose }) {
  const [menu, setMenu] = useState(null);
  useEffect(() => {
    if (!open) setMenu(null);
  }, [open]);
  if (!open) return null;
  const active = downloads.filter((item) => ["queued", "downloading"].includes(item.status)).length;
  const statusText = {
    queued: "排队中",
    downloading: "下载中",
    completed: "已完成",
    cancelled: "已暂停",
    error: "失败"
  };
  const progressFor = (item) => item.size ? Math.min(100, Math.round((Number(item.downloaded || 0) / Number(item.size)) * 100)) : 0;
  return (
    <div className="download-layer" onClick={() => setMenu(null)}>
      <section className="download-panel" onClick={(event) => event.stopPropagation()}>
        <header>
          <div>
            <h2>下载</h2>
            <p>{active ? `${active} 个任务进行中` : "暂无活动下载"}</p>
          </div>
          <button className="icon-button" onClick={onClose} title="关闭"><X size={18} /></button>
        </header>
        <div className="download-list">
          {downloads.map((item) => {
            const progress = progressFor(item);
            return (
              <article
                className={cx("download-item", item.status)}
                key={item.id}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenu({ task: item, x: event.clientX, y: event.clientY });
                }}
              >
                <div className="download-item-head">
                  <strong>{item.fileName || "Telegram 媒体"}</strong>
                  <span>{statusText[item.status] || item.status}</span>
                </div>
                <div className="download-meta">
                  <span>{formatBytes(item.downloaded)} / {formatBytes(item.size)}</span>
                  <span>{item.status === "downloading" ? `${formatBytes(item.speedBps)}/s` : formatTime(item.updatedAt)}</span>
                </div>
                <div className="download-progress"><i style={{ width: `${progress}%` }} /></div>
                {item.error && <p className="download-error">{item.error}</p>}
                <div className="download-actions">
                  {item.status !== "downloading" && item.status !== "completed" && <button onClick={() => onStart(item)}><Play size={14} />开始</button>}
                  {item.status === "downloading" && <button onClick={() => onCancel(item)}><X size={14} />取消</button>}
                  <button onClick={() => onDelete(item)}><Trash2 size={14} />删除</button>
                </div>
              </article>
            );
          })}
          {!downloads.length && <div className="empty">点击视频右上角缓存后，任务会出现在这里。</div>}
        </div>
        {menu && <div className="download-menu" style={{ left: menu.x, top: menu.y }} onClick={(event) => event.stopPropagation()}>
          {menu.task.status !== "downloading" && menu.task.status !== "completed" && <button onClick={() => { onStart(menu.task); setMenu(null); }}>开始/继续</button>}
          {menu.task.status === "downloading" && <button onClick={() => { onCancel(menu.task); setMenu(null); }}>取消</button>}
          <button onClick={() => { onDelete(menu.task); setMenu(null); }}>删除任务和缓存</button>
        </div>}
      </section>
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
  const [appSettings, setAppSettings] = useState({
    notificationEnabled: true,
    notificationPreview: true,
    privacyOpenTelegramLinksInApp: true,
    privacyMediaPreview: true,
    messageShowSender: true,
    foldersEnabled: true,
    foldersShowArchived: false,
    foldersAutoSelectFirst: true
  });
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
  const [downloads, setDownloads] = useState([]);
  const [downloadOpen, setDownloadOpen] = useState(false);
  const socket = useSocket(token);
  const messagesRef = useRef(null);
  const shouldScrollBottomRef = useRef(false);
  const activeAccount = accounts.find((account) => account.id === accountId);
  const newestAnnouncementId = announcements[0]?.id || "";
  const unreadAnnouncement = newestAnnouncementId && localStorage.getItem("feigrame.lastAnnouncement") !== newestAnnouncementId;
  const messageItems = useMemo(() => buildMessageItems(messages), [messages]);
  const activeDownloadCount = downloads.filter((item) => ["queued", "downloading"].includes(item.status)).length;
  const visibleChats = useMemo(() => {
    const folder = folders.find((item) => String(item.id) === String(activeFolder));
    if (!folder) return chats;
    if (folder.chatIds?.length) {
      const ids = new Set(folder.chatIds);
      return chats.filter((chat) => ids.has(chat.id));
    }
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
    loadSettings();
    loadAnnouncements();
    loadAbout();
    loadDownloads();
    refreshAccounts();
  }, [token]);

  useEffect(() => {
    if (!accountId) return;
    socket?.emit("account:join", accountId);
    if (appSettings.foldersEnabled) loadFolders();
    else {
      setFolders([]);
      setActiveFolder("all");
    }
    loadChats();
  }, [accountId, socket, appSettings.foldersEnabled]);

  useEffect(() => {
    if (!socket) return;
    const handler = ({ accountId: incomingAccount, message }) => {
      if (incomingAccount !== accountId) return;
      const stick = isNearBottom(messagesRef.current);
      if (notifications && appSettings.notificationEnabled && !message.outgoing && message.text) {
        new Notification("Feigram 新消息", { body: appSettings.notificationPreview ? message.text.slice(0, 120) : "收到一条新消息" });
      }
      shouldScrollBottomRef.current = stick;
      setMessages((current) => [...current, message]);
    };
    socket.on("message:new", handler);
    return () => socket.off("message:new", handler);
  }, [socket, accountId, notifications, appSettings.notificationEnabled, appSettings.notificationPreview]);

  useEffect(() => {
    if (!socket) return;
    const update = (task) => {
      setDownloads((current) => {
        const index = current.findIndex((item) => item.id === task.id);
        if (index === -1) return [task, ...current];
        const next = [...current];
        next[index] = task;
        return next.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      });
    };
    const remove = ({ id }) => setDownloads((current) => current.filter((item) => item.id !== id));
    socket.on("download:update", update);
    socket.on("download:delete", remove);
    return () => {
      socket.off("download:update", update);
      socket.off("download:delete", remove);
    };
  }, [socket]);

  useEffect(() => {
    const element = messagesRef.current;
    if (!element || loadingOlder || !shouldScrollBottomRef.current) return;
    shouldScrollBottomRef.current = false;
    requestAnimationFrame(() => {
      element.scrollTop = element.scrollHeight;
    });
  }, [activeChat?.id, messages.length, loadingOlder]);

  function isNearBottom(element) {
    if (!element) return true;
    return element.scrollHeight - element.scrollTop - element.clientHeight < 96;
  }

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
      const visible = appSettings.foldersShowArchived ? list : list.filter((chat) => !chat.archived);
      setChats(visible);
      if (appSettings.foldersAutoSelectFirst && !activeChat && visible[0]) selectChat(visible[0]);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function clearSearch() {
    setQuery("");
    await loadChats("");
  }

  async function loadFolders() {
    if (!accountId) return;
    const list = await api(`/api/folders?account=${encodeURIComponent(accountId)}`).catch(() => []);
    setFolders(list);
    setActiveFolder("all");
  }

  async function selectChat(chat) {
    setActiveChat(chat);
    shouldScrollBottomRef.current = true;
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
    const element = messagesRef.current;
    const top = element?.scrollTop || 0;
    const list = await api(`/api/messages?account=${encodeURIComponent(accountId)}&peer=${encodeURIComponent(activeChat.id)}&limit=80`);
    setMessages(list);
    setHasOlder(list.length >= 80);
    requestAnimationFrame(() => {
      if (element) element.scrollTop = top;
    });
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
    if (!appSettings.privacyOpenTelegramLinksInApp) {
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

  async function cacheMedia(message) {
    setError("");
    try {
      const result = await api(`/api/media/${accountId}/${encodeURIComponent(activeChat.id)}/${message.id}/cache`, { method: "POST" });
      setDownloads((current) => [result, ...current.filter((item) => item.id !== result.id)]);
      notify(`${result.fileName || "视频"} 已加入下载列表`);
      return result;
    } catch (err) {
      notify(err.message);
      throw err;
    }
  }

  async function sendMessage(event) {
    event.preventDefault();
    if (!draft.trim() || !activeChat) return;
    const text = draft.trim();
    setDraft("");
    try {
      const sent = await api("/api/messages", { method: "POST", body: JSON.stringify({ account: accountId, peer: activeChat.id, text }) });
      shouldScrollBottomRef.current = true;
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

  async function loadDownloads() {
    const list = await api("/api/downloads").catch(() => []);
    setDownloads(list);
  }

  async function updateDownload(task, action, method = "POST") {
    try {
      const result = await api(`/api/downloads/${encodeURIComponent(task.id)}/${action}`, { method });
      if (result?.id) {
        setDownloads((current) => [result, ...current.filter((item) => item.id !== result.id)]);
      }
      return result;
    } catch (err) {
      notify(err.message);
      throw err;
    }
  }

  async function startDownload(task) {
    return updateDownload(task, "start");
  }

  async function cancelDownload(task) {
    return updateDownload(task, "cancel");
  }

  async function deleteDownload(task) {
    try {
      await api(`/api/downloads/${encodeURIComponent(task.id)}`, { method: "DELETE" });
      setDownloads((current) => current.filter((item) => item.id !== task.id));
    } catch (err) {
      notify(err.message);
    }
  }

  async function loadSettings() {
    const settings = await api("/api/settings").catch(() => ({}));
    setAppSettings({
      notificationEnabled: settings.notificationEnabled !== false,
      notificationPreview: settings.notificationPreview !== false,
      privacyOpenTelegramLinksInApp: settings.privacyOpenTelegramLinksInApp !== false,
      privacyMediaPreview: settings.privacyMediaPreview !== false,
      messageShowSender: settings.messageShowSender !== false,
      foldersEnabled: settings.foldersEnabled !== false,
      foldersShowArchived: Boolean(settings.foldersShowArchived),
      foldersAutoSelectFirst: settings.foldersAutoSelectFirst !== false
    });
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
        <div className="sidebar-main">
          {appSettings.foldersEnabled && <nav className="folder-tabs">
            <button className={cx(activeFolder === "all" && "active")} onClick={() => setActiveFolder("all")}>
              <MessageSquare size={24} /><span>全部</span>
            </button>
            {folders.map((folder) => <button key={folder.id} className={cx(String(activeFolder) === String(folder.id) && "active")} onClick={() => setActiveFolder(folder.id)}>
              <Folder size={24} /><span>{folder.emoticon ? `${folder.emoticon} ` : ""}{folder.title}</span>
              {!!folder.chatIds?.length && <b>{folder.chatIds.length}</b>}
            </button>)}
            <button onClick={() => { setAdminInitialTab("folders"); setAdminOpen(true); }}>
              <SlidersHorizontal size={24} /><span>编辑</span>
            </button>
            <button className={cx(downloadOpen && "active")} onClick={() => setDownloadOpen(true)}>
              <Download size={24} /><span>下载</span>
              {!!activeDownloadCount && <b>{activeDownloadCount}</b>}
            </button>
          </nav>}
          <div className="chat-pane">
            <form className="search" onSubmit={(event) => { event.preventDefault(); loadChats(query); }}>
              <Search size={17} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索私聊、群组、频道" />
              {query && <button type="button" title="清除搜索" onClick={clearSearch}><X size={16} /></button>}
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
          </div>
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
            {messageItems.map((item) => <MessageBubble
              key={item.id}
              item={item}
              accountId={accountId}
              chatId={activeChat.id}
              showSender={appSettings.messageShowSender}
              showMedia={appSettings.privacyMediaPreview}
              onOpenLink={openTelegramLink}
              onInlineButton={clickInlineButton}
              onCacheMedia={cacheMedia}
              downloadTasks={downloads}
            />)}
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
        onSettingsChanged={loadSettings}
        open={adminOpen}
        initialTab={adminInitialTab}
        onClose={() => setAdminOpen(false)}
        socket={socket}
      />
      <InfoModal announcements={announcements} about={about} open={announcementOpen} onClose={() => setAnnouncementOpen(false)} />
      <DownloadCenter
        open={downloadOpen}
        downloads={downloads}
        onStart={startDownload}
        onCancel={cancelDownload}
        onDelete={deleteDownload}
        onClose={() => setDownloadOpen(false)}
      />
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
