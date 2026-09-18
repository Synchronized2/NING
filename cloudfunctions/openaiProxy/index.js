const cloud = require("wx-server-sdk");
const dns = require("node:dns").promises;
const https = require("node:https");
const net = require("node:net");
const crypto = require("node:crypto");
const { EDGE_VOICES_URL, synthesizeEdge } = require("./edge-tts");
const { buildEndpoint, isPrivateIp } = require("./security");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const MAX_MODEL_BYTES = 4 * 1024 * 1024;
const MAX_CHAT_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_JSON_BYTES = 28 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_INPUT_MEDIA_BYTES = 10 * 1024 * 1024;

const IMAGE_TOOL = {
  type: "function",
  function: {
    name: "generate_image",
    description: "Generate an image only when the user explicitly asks to create, draw, or generate one.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "A complete standalone prompt for the image generation model.",
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
};

class ProxyError extends Error {
  constructor(message, statusCode = 0) {
    super(message);
    this.statusCode = statusCode;
  }
}

function requireText(value, name, maxLength) {
  const text = String(value || "").trim();
  if (!text) throw new ProxyError(`${name}不能为空。`);
  if (text.length > maxLength) throw new ProxyError(`${name}过长。`);
  return text;
}

async function resolvePublicAddress(hostname) {
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost") || lower.endsWith(".local") || lower.endsWith(".internal")) {
    throw new ProxyError("不允许访问本机或内网服务地址。");
  }
  let records;
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (_) {
    throw new ProxyError("无法解析模型服务域名。");
  }
  if (!records.length || records.some((item) => isPrivateIp(item.address))) {
    throw new ProxyError("模型服务域名解析到了非公网地址。");
  }
  return records[0];
}

function pinnedLookup(record) {
  return (_hostname, options, callback) => {
    const settings = typeof options === "object" ? options : {};
    const done = typeof options === "function" ? options : callback;
    if (settings.all) {
      done(null, [{ address: record.address, family: record.family }]);
    } else {
      done(null, record.address, record.family);
    }
  };
}

async function requestBuffer(target, options = {}, redirects = 0) {
  if (!(target instanceof URL)) target = new URL(target);
  if (target.protocol !== "https:" || target.username || target.password) {
    throw new ProxyError("只允许访问不含凭据的 HTTPS 地址。");
  }
  const hostname = target.hostname.replace(/^\[|\]$/g, "");
  const record = await resolvePublicAddress(hostname);
  const body = options.body
    ? (Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body, "utf8"))
    : null;
  const result = await new Promise((resolve, reject) => {
    const request = https.request(target, {
      method: options.method || "GET",
      lookup: pinnedLookup(record),
      servername: net.isIP(hostname) ? undefined : hostname,
      headers: {
        Accept: options.accept || "application/json",
        "User-Agent": "Mozilla/5.0 AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
        ...(options.headers || {}),
        ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
        ...(body ? {
          "Content-Type": options.contentType || "application/json; charset=utf-8",
          "Content-Length": body.length,
        } : {}),
      },
    }, (response) => {
      const declared = Number(response.headers["content-length"] || 0);
      if (declared > options.maxBytes) {
        response.destroy();
        reject(new ProxyError("上游响应体积超过限制。", response.statusCode));
        return;
      }
      const chunks = [];
      let total = 0;
      response.on("data", (chunk) => {
        total += chunk.length;
        if (total > options.maxBytes) {
          response.destroy(new ProxyError("上游响应体积超过限制。", response.statusCode));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({
        statusCode: response.statusCode || 0,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
      response.on("error", reject);
    });
    request.setTimeout(options.timeout || 120000, () => request.destroy(new ProxyError("请求模型服务超时。")));
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });

  if (result.statusCode >= 300 && result.statusCode < 400 && result.headers.location) {
    if (redirects >= 2) throw new ProxyError("模型服务重定向次数过多。", result.statusCode);
    const next = new URL(result.headers.location, target);
    if (next.origin !== target.origin) throw new ProxyError("拒绝向其他域名的重定向转发 API Key。", result.statusCode);
    return requestBuffer(next, options, redirects + 1);
  }
  return result;
}

function parseJson(buffer, label) {
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch (_) {
    throw new ProxyError(`${label}返回了无法解析的 JSON。`);
  }
}

function upstreamError(response) {
  const shortBody = response.body.subarray(0, 16384);
  let message = "模型服务请求失败";
  try {
    const parsed = JSON.parse(shortBody.toString("utf8"));
    message = (parsed.error && (parsed.error.message || parsed.error)) || parsed.message || message;
  } catch (_) {
    message = shortBody.toString("utf8").replace(/\s+/g, " ").trim().slice(0, 500) || message;
  }
  return new ProxyError(`HTTP ${response.statusCode}：${String(message).slice(0, 500)}`, response.statusCode);
}

async function upstreamJson(url, { apiKey, method = "GET", payload, maxBytes, timeout }) {
  const response = await requestBuffer(url, {
    method,
    apiKey,
    body: payload === undefined ? null : JSON.stringify(payload),
    maxBytes,
    timeout,
  });
  if (response.statusCode < 200 || response.statusCode >= 300) throw upstreamError(response);
  return parseJson(response.body, "模型服务");
}

function mediaMimeType(fileName, buffer) {
  const lower = String(fileName || "").toLowerCase();
  if (lower.endsWith(".png") || buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (lower.endsWith(".webp") || buffer.subarray(0, 4).toString("ascii") === "RIFF") return "image/webp";
  return "image/jpeg";
}

async function cloudFileBuffer(fileId) {
  if (!/^cloud:\/\//i.test(String(fileId || ""))) throw new ProxyError("媒体文件标识无效。");
  let result;
  try {
    result = await cloud.downloadFile({ fileID: fileId });
  } catch (_) {
    throw new ProxyError("无法读取上传的媒体文件。");
  }
  const buffer = result && result.fileContent;
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_INPUT_MEDIA_BYTES) {
    throw new ProxyError("媒体文件为空或超过 10 MB 限制。");
  }
  return buffer;
}

async function sanitizedMessages(value) {
  if (!Array.isArray(value) || !value.length || value.length > 40) {
    throw new ProxyError("对话消息数量无效。");
  }
  let total = 0;
  let mediaCount = 0;
  const output = [];
  for (const item of value) {
    if (!item || !["system", "user", "assistant"].includes(item.role)) {
      throw new ProxyError("对话消息格式无效。");
    }
    if (typeof item.content === "string") {
      total += item.content.length;
      output.push({ role: item.role, content: item.content });
      continue;
    }
    if (item.role !== "user" || !Array.isArray(item.content) || !item.content.length) {
      throw new ProxyError("对话消息内容格式无效。");
    }
    const parts = [];
    for (const part of item.content) {
      if (part && part.type === "text" && typeof part.text === "string") {
        total += part.text.length;
        parts.push({ type: "text", text: part.text });
      } else if (part && part.type === "image_url" && part.image_url && typeof part.image_url.url === "string") {
        mediaCount += 1;
        if (mediaCount > 4) throw new ProxyError("单次对话最多携带 4 张图片。");
        const fileId = part.image_url.url;
        const buffer = await cloudFileBuffer(fileId);
        const mimeType = mediaMimeType(fileId, buffer);
        parts.push({ type: "image_url", image_url: { url: `data:${mimeType};base64,${buffer.toString("base64")}` } });
      } else {
        throw new ProxyError("对话消息包含不支持的媒体内容。");
      }
    }
    output.push({ role: item.role, content: parts });
  }
  if (total > 300000) throw new ProxyError("对话内容过长。");
  return output;
}

async function handleModels(event) {
  const apiKey = requireText(event.apiKey, "API Key", 2000);
  const response = await upstreamJson(buildEndpoint(event.baseUrl, "models"), {
    apiKey,
    maxBytes: MAX_MODEL_BYTES,
    timeout: 30000,
  });
  if (!Array.isArray(response.data)) throw new ProxyError("模型列表响应中缺少 data 字段。");
  const models = response.data
    .map((item) => typeof item === "string" ? item : item && item.id)
    .filter((item) => typeof item === "string" && item.trim())
    .map((item) => item.trim())
    .slice(0, 1000);
  return { models };
}

async function requestChat(event, includeTools) {
  const apiKey = requireText(event.apiKey, "API Key", 2000);
  const payload = {
    model: requireText(event.model, "对话模型", 300),
    messages: await sanitizedMessages(event.messages),
    stream: false,
  };
  if (includeTools) {
    payload.tools = [IMAGE_TOOL];
    payload.tool_choice = "auto";
  }
  return upstreamJson(buildEndpoint(event.baseUrl, "chat/completions"), {
    method: "POST",
    apiKey,
    payload,
    maxBytes: MAX_CHAT_BYTES,
    timeout: 120000,
  });
}

async function handleChat(event) {
  const includeTools = event.enableImageTool === true;
  try {
    return { response: await requestChat(event, includeTools), toolsSupported: includeTools };
  } catch (error) {
    if (!includeTools || error.statusCode !== 400) throw error;
    return { response: await requestChat(event, false), toolsSupported: false };
  }
}

function decodeBase64(value) {
  const encoded = String(value || "").replace(/\s/g, "");
  if (!encoded || !/^[a-z0-9+/]*={0,2}$/i.test(encoded)) throw new ProxyError("节点返回了无效的 Base64 图片。");
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new ProxyError("生成图片为空或超过 20 MB 限制。");
  return bytes;
}

function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { extension: "png", contentType: "image/png" };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { extension: "jpg", contentType: "image/jpeg" };
  }
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return { extension: "webp", contentType: "image/webp" };
  }
  throw new ProxyError("节点返回的数据不是 PNG、JPEG 或 WebP 图片。");
}

async function downloadImage(url) {
  let target;
  try {
    target = new URL(url);
  } catch (_) {
    throw new ProxyError("节点返回了无效的图片地址。");
  }
  const response = await requestBuffer(target, {
    method: "GET",
    accept: "image/*",
    maxBytes: MAX_IMAGE_BYTES,
    timeout: 60000,
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new ProxyError(`下载生成图片失败：HTTP ${response.statusCode}`);
  }
  return response.body;
}

async function handleImage(event, context) {
  const apiKey = requireText(event.apiKey, "API Key", 2000);
  const prompt = requireText(event.prompt, "图片描述", 32000);
  const payload = {
    model: requireText(event.model, "生图模型", 300),
    prompt,
    n: 1,
  };
  if (event.size) payload.size = requireText(event.size, "图片尺寸", 30);
  if (event.quality) payload.quality = requireText(event.quality, "图片质量", 30);
  if (event.style) payload.style = requireText(event.style, "图片风格", 30);
  const response = await upstreamJson(buildEndpoint(event.baseUrl, "images/generations"), {
    method: "POST",
    apiKey,
    payload,
    maxBytes: MAX_IMAGE_JSON_BYTES,
    timeout: 55000,
  });
  const first = Array.isArray(response.data) ? response.data[0] : null;
  if (!first) throw new ProxyError("节点没有返回图片数据。");
  const bytes = first.b64_json ? decodeBase64(first.b64_json) : await downloadImage(first.url);
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new ProxyError("生成图片为空或超过 20 MB 限制。");
  const type = imageType(bytes);
  const owner = String(context.OPENID || "anonymous").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "anonymous";
  const date = new Date().toISOString().slice(0, 10);
  const suffix = crypto.randomBytes(6).toString("hex");
  const upload = await cloud.uploadFile({
    cloudPath: `openaiq/${owner}/${date}/${Date.now()}-${suffix}.${type.extension}`,
    fileContent: bytes,
  });
  return {
    fileId: upload.fileID,
    contentType: type.contentType,
    revisedPrompt: first.revised_prompt || "",
  };
}

async function handleTtsVoices() {
  const response = await requestBuffer(EDGE_VOICES_URL, {
    method: "GET",
    maxBytes: MAX_MODEL_BYTES,
    timeout: 20000,
  });
  if (response.statusCode < 200 || response.statusCode >= 300) throw new ProxyError(`获取 Edge TTS 人声失败：HTTP ${response.statusCode}`);
  const voices = parseJson(response.body, "Edge TTS");
  if (!Array.isArray(voices)) throw new ProxyError("Edge TTS 人声列表格式无效。");
  return {
    voices: voices.map((item) => ({
      shortName: String(item.ShortName || ""),
      localName: String(item.LocalName || item.FriendlyName || item.ShortName || ""),
      locale: String(item.Locale || ""),
      gender: String(item.Gender || ""),
    })).filter((item) => item.shortName).slice(0, 500),
  };
}

async function handleTts(event, context) {
  const text = requireText(event.text, "朗读文本", 5000);
  const voice = requireText(event.voice || "zh-CN-XiaoxiaoNeural", "TTS 人声", 100);
  if (!/^[a-z]{2,3}(?:-[a-zA-Z0-9]+){2,4}Neural$/.test(voice)) throw new ProxyError("TTS 人声名称无效。");
  const audio = await synthesizeEdge(text, voice, event);
  if (!audio.length || audio.length > MAX_INPUT_MEDIA_BYTES) throw new ProxyError("TTS 音频为空或超过 10 MB 限制。");
  const owner = String(context.OPENID || "anonymous").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "anonymous";
  const suffix = crypto.randomBytes(6).toString("hex");
  const upload = await cloud.uploadFile({
    cloudPath: `openaiq-tts/${owner}/${new Date().toISOString().slice(0, 10)}/${Date.now()}-${suffix}.mp3`,
    fileContent: audio,
  });
  return { fileId: upload.fileID };
}

function safeError(error, apiKey) {
  let message = String((error && error.message) || "云函数处理失败").slice(0, 800);
  if (apiKey) message = message.split(String(apiKey)).join("[REDACTED]");
  return {
    ok: false,
    statusCode: Number(error && error.statusCode) || 0,
    error: message,
  };
}

exports.main = async (event = {}) => {
  try {
    let data;
    if (event.action === "models") data = await handleModels(event);
    else if (event.action === "chat") data = await handleChat(event);
    else if (event.action === "image") data = await handleImage(event, cloud.getWXContext());
    else if (event.action === "ttsVoices") data = await handleTtsVoices();
    else if (event.action === "tts") data = await handleTts(event, cloud.getWXContext());
    else throw new ProxyError("不支持的云函数操作。");
    return { ok: true, data };
  } catch (error) {
    return safeError(error, event.apiKey);
  }
};
