const dns = require("node:dns").promises;
const net = require("node:net");

const KNOWN_RESOURCES = [
  "/chat/completions",
  "/images/generations",
  "/images/edits",
  "/models",
];

function buildEndpoint(baseUrl, resource) {
  const raw = String(baseUrl || "").trim();
  if (!raw || raw.length > 1000) throw new Error("服务 URL 无效。");
  let url;
  try {
    url = new URL(raw);
  } catch (_) {
    throw new Error("服务 URL 无效。");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("服务 URL 必须是不含凭据、查询参数和片段的 HTTPS 地址。");
  }
  let path = url.pathname.replace(/\/+$/, "");
  const lower = path.toLowerCase();
  const known = KNOWN_RESOURCES.find((item) => lower.endsWith(item));
  if (known) path = path.slice(0, -known.length).replace(/\/+$/, "");
  url.pathname = `${path || "/v1"}/${resource}`.replace(/\/{2,}/g, "/");
  return url;
}

function isPrivateIpv4(address) {
  const parts = String(address || "").split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113);
}

function isPrivateIp(address) {
  const value = String(address || "").toLowerCase().split("%")[0];
  const family = net.isIP(value);
  if (family === 4) return isPrivateIpv4(value);
  if (family !== 6) return true;
  if (value === "::" || value === "::1" || value.startsWith("ff")) return true;
  if (value.startsWith("::ffff:")) {
    const mapped = value.slice(7);
    if (mapped.includes(".")) return isPrivateIpv4(mapped);
    const words = mapped.split(":");
    if (words.length === 2) {
      const high = parseInt(words[0], 16);
      const low = parseInt(words[1], 16);
      if (Number.isInteger(high) && Number.isInteger(low)) {
        return isPrivateIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
      }
    }
    return true;
  }
  if (value.startsWith("::")) return true;
  const first = parseInt(value.split(":")[0] || "0", 16);
  return (first >= 0xfc00 && first <= 0xfdff) ||
    (first >= 0xfe80 && first <= 0xfeff) ||
    value.startsWith("64:ff9b:") ||
    value.startsWith("2001:2:") ||
    value.startsWith("2001:db8:");
}

async function resolvePublicAddress(hostname) {
  const lower = String(hostname || "").toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost") || lower.endsWith(".local") || lower.endsWith(".internal")) {
    throw new Error("不允许访问本机或内网服务地址。");
  }
  let records;
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (_) {
    throw new Error("无法解析模型服务域名。");
  }
  if (!records.length || records.some((item) => isPrivateIp(item.address))) {
    throw new Error("模型服务域名解析到了非公网地址。");
  }
  return records[0];
}

function pinnedLookup(record) {
  return (_hostname, options, callback) => {
    const settings = typeof options === "object" ? options : {};
    const done = typeof options === "function" ? options : callback;
    if (settings.all) done(null, [{ address: record.address, family: record.family }]);
    else done(null, record.address, record.family);
  };
}

module.exports = { buildEndpoint, isPrivateIp, isPrivateIpv4, pinnedLookup, resolvePublicAddress };
