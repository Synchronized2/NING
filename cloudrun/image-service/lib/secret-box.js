const crypto = require("node:crypto");

function encryptionKey(secret) {
  const value = String(secret || "");
  if (value.length < 32) throw new Error("TASK_ENCRYPTION_KEY 必须至少包含 32 个字符。");
  return crypto.createHash("sha256").update(value, "utf8").digest();
}

function seal(value, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(secret), iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    version: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: ciphertext.toString("base64"),
  };
}

function open(box, secret) {
  if (!box || box.version !== 1 || !box.iv || !box.tag || !box.data) {
    throw new Error("任务凭据格式无效。");
  }
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    encryptionKey(secret),
    Buffer.from(box.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(box.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(box.data, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8"));
}

module.exports = { open, seal };
