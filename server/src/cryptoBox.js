const crypto = require("crypto");
const { getSecret } = require("./store");

async function key() {
  return crypto.createHash("sha256").update(await getSecret()).digest();
}

async function encryptText(plainText) {
  if (!plainText) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", await key(), iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

async function decryptText(payload) {
  if (!payload) return "";
  if (!String(payload).startsWith("v1:")) return payload;
  const [, iv, tag, encrypted] = String(payload).split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", await key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, "base64")),
    decipher.final()
  ]).toString("utf8");
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(String(password), salt, 210000, 32, "sha256").toString("hex");
  return `pbkdf2:${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const [, salt, expected] = stored.split(":");
  const actual = hashPassword(password, salt).split(":")[2];
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

module.exports = {
  decryptText,
  encryptText,
  hashPassword,
  verifyPassword
};
