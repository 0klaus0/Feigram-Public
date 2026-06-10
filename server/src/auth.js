const crypto = require("crypto");
const { findUserByUsername, getSecret, readUsers, safeId, upsertUser } = require("./store");
const { hashPassword, verifyPassword } = require("./cryptoBox");

async function makeUserToken(userId) {
  const secret = await getSecret();
  const payload = Buffer.from(JSON.stringify({ userId, iat: Date.now() })).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

async function verifyUserToken(token) {
  if (!token || !token.includes(".")) return null;
  const secret = await getSecret();
  const [payload, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  if (Buffer.from(sig).length !== Buffer.from(expected).length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  const user = (await readUsers()).find((item) => item.id === parsed.userId && !item.disabled);
  return user || null;
}

async function login(req, res) {
  const { username, password } = req.body || {};
  const user = await findUserByUsername(username);
  if (!user || user.disabled || !verifyPassword(password, user.passwordHash)) {
    res.status(401).json({ error: "飞牛账户或密码不正确" });
    return;
  }
  res.json({ token: await makeUserToken(user.id), user: publicUser(user) });
}

async function bootstrap(req, res) {
  if ((await readUsers()).length > 0) {
    res.status(403).json({ error: "管理员已创建" });
    return;
  }
  const { username, password } = req.body || {};
  if (!username || !password || String(password).length < 8) {
    res.status(400).json({ error: "请输入飞牛账户和至少 8 位密码" });
    return;
  }
  const user = await upsertUser({
    id: safeId("user"),
    username: String(username).trim(),
    displayName: "Administrator",
    role: "admin",
    disabled: false,
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString()
  });
  res.json({ token: await makeUserToken(user.id), user: publicUser(user) });
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName || user.username,
    role: user.role || "user",
    disabled: Boolean(user.disabled),
    createdAt: user.createdAt
  };
}

function authMiddleware() {
  return async (req, res, next) => {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : req.query.token || "";
    const user = await verifyUserToken(token);
    if (user) {
      req.user = user;
      next();
      return;
    }
    res.status(401).json({ error: "请先输入应用访问密码" });
  };
}

function adminOnly(req, res, next) {
  if (req.user?.role === "admin") {
    next();
    return;
  }
  res.status(403).json({ error: "需要管理员权限" });
}

async function bootstrapStatus(_req, res) {
  res.json({ required: (await readUsers()).length === 0 });
}

module.exports = {
  adminOnly,
  authMiddleware,
  bootstrap,
  bootstrapStatus,
  login,
  makeUserToken,
  publicUser,
  verifyUserToken
};
