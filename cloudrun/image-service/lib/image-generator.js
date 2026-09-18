const crypto = require("node:crypto");
const https = require("node:https");
const net = require("node:net");
const { buildEndpoint, pinnedLookup, resolvePublicAddress } = require("./security");

const MAX_IMAGE_JSON_BYTES = 28 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 600000;

class ImageServiceError extends Error {
  constructor(message, statusCode = 0) {
    super(message);
    this.statusCode = statusCode;
  }
}

function requireText(value, name, maxLength) {
  const text = String(value || "").trim();
  if (!text) throw new ImageServiceError(`${name}不能为空。`, 400);
  if (text.length > maxLength) throw new ImageServiceError(`${name}过长。`, 400);
  return text;
}

async function requestBuffer(target, options = {}, redirects = 0) {
  if (!(target instanceof URL)) target = new URL(target);
  if (target.protocol !== "https:" || target.username || target.password) {
    throw new ImageServiceError("只允许访问不含凭据的 HTTPS 地址。", 400);
  }
  const hostname = target.hostname.replace(/^\[|\]$/g, "");
  const record = await resolvePublicAddress(hostname);
  const body = options.body
    ? (Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body, "utf8"))
    : null;
  const result = await new Promise((resolve, reject) => {
    if (options.signal && options.signal.aborted) {
      reject(new ImageServiceError("任务已取消。", 499));
      return;
    }
    const request = https.request(target, {
      method: options.method || "GET",
      lookup: pinnedLookup(record),
      servername: net.isIP(hostname) ? undefined : hostname,
      headers: {
        Accept: options.accept || "application/json",
        "User-Agent": "OpenAIQ-Image-Service/2.2",
        ...(options.headers || {}),
        ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
        ...(body ? {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": body.length,
        } : {}),
      },
    }, (response) => {
      const declared = Number(response.headers["content-length"] || 0);
      if (declared > options.maxBytes) {
        response.destroy();
        reject(new ImageServiceError("上游响应体积超过限制。", response.statusCode));
        return;
      }
      const chunks = [];
      let total = 0;
      response.on("data", (chunk) => {
        total += chunk.length;
        if (total > options.maxBytes) {
          response.destroy(new ImageServiceError("上游响应体积超过限制。", response.statusCode));
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
    const abort = () => request.destroy(
      options.signal.reason instanceof ImageServiceError
        ? options.signal.reason
        : new ImageServiceError("任务已取消。", 499),
    );
    if (options.signal) options.signal.addEventListener("abort", abort, { once: true });
    request.setTimeout(options.timeout || IMAGE_TIMEOUT_MS, () => {
      request.destroy(new ImageServiceError("生图服务等待超过 10 分钟。", 504));
    });
    request.on("error", reject);
    request.on("close", () => {
      if (options.signal) options.signal.removeEventListener("abort", abort);
    });
    if (body) request.write(body);
    request.end();
  });

  if (result.statusCode >= 300 && result.statusCode < 400 && result.headers.location) {
    if (redirects >= 2) throw new ImageServiceError("模型服务重定向次数过多。", result.statusCode);
    const next = new URL(result.headers.location, target);
    if (options.apiKey && next.origin !== target.origin) {
      throw new ImageServiceError("拒绝向其他域名的重定向转发 API Key。", result.statusCode);
    }
    return requestBuffer(next, options, redirects + 1);
  }
  return result;
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
  return new ImageServiceError(`HTTP ${response.statusCode}：${String(message).slice(0, 500)}`, response.statusCode);
}

async function requestImage(input, taskId, signal) {
  const payload = {
    model: requireText(input.model, "生图模型", 300),
    prompt: requireText(input.prompt, "图片描述", 32000),
    n: 1,
  };
  if (input.size) payload.size = requireText(input.size, "图片尺寸", 30);
  if (input.quality) payload.quality = requireText(input.quality, "图片质量", 30);
  if (input.style) payload.style = requireText(input.style, "图片风格", 30);
  const response = await requestBuffer(buildEndpoint(input.baseUrl, "images/generations"), {
    method: "POST",
    apiKey: requireText(input.apiKey, "API Key", 2000),
    body: JSON.stringify(payload),
    maxBytes: MAX_IMAGE_JSON_BYTES,
    timeout: IMAGE_TIMEOUT_MS,
    signal,
    headers: { "Idempotency-Key": taskId },
  });
  if (response.statusCode < 200 || response.statusCode >= 300) throw upstreamError(response);
  try {
    return JSON.parse(response.body.toString("utf8"));
  } catch (_) {
    throw new ImageServiceError("模型服务返回了无法解析的 JSON。", 502);
  }
}

function unsupportedParameter(error, name) {
  if (!error || Number(error.statusCode) !== 400) return false;
  const message = String(error.message || "").toLowerCase();
  return message.includes(name) && /unknown|unsupported|not supported|unrecognized|invalid (?:value|parameter|argument)/.test(message);
}

async function requestCompatibleImage(input, taskId, signal) {
  const parameters = { ...input };
  while (true) {
    try {
      return await requestImage(parameters, taskId, signal);
    } catch (error) {
      if (parameters.style && unsupportedParameter(error, "style")) {
        parameters.style = "";
        continue;
      }
      if (parameters.quality && unsupportedParameter(error, "quality")) {
        parameters.quality = "";
        continue;
      }
      throw error;
    }
  }
}

function decodeBase64(value) {
  const encoded = String(value || "").replace(/\s/g, "");
  if (!encoded || !/^[a-z0-9+/]*={0,2}$/i.test(encoded)) throw new ImageServiceError("节点返回了无效的 Base64 图片。", 502);
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new ImageServiceError("生成图片为空或超过 20 MB 限制。", 502);
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
  throw new ImageServiceError("节点返回的数据不是 PNG、JPEG 或 WebP 图片。", 502);
}

async function downloadImage(url, signal) {
  if (!url) throw new ImageServiceError("生图响应中没有 b64_json 或 url 字段。", 502);
  let target;
  try {
    target = new URL(url);
  } catch (_) {
    throw new ImageServiceError("节点返回了无效的图片地址。", 502);
  }
  const response = await requestBuffer(target, {
    method: "GET",
    accept: "image/*",
    maxBytes: MAX_IMAGE_BYTES,
    timeout: 120000,
    signal,
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new ImageServiceError(`下载生成图片失败：HTTP ${response.statusCode}`, response.statusCode);
  }
  return response.body;
}

async function generateImage(input, context) {
  const response = await requestCompatibleImage(input, context.taskId, context.signal);
  const first = Array.isArray(response.data) ? response.data[0] : null;
  if (!first) throw new ImageServiceError("节点没有返回图片数据。", 502);
  const bytes = first.b64_json ? decodeBase64(first.b64_json) : await downloadImage(first.url, context.signal);
  const type = imageType(bytes);
  const date = new Date().toISOString().slice(0, 10);
  const suffix = crypto.randomBytes(6).toString("hex");
  const uploaded = await context.cloudbase.uploadFile({
    cloudPath: `openaiq/${context.owner}/${date}/${Date.now()}-${suffix}.${type.extension}`,
    fileContent: bytes,
  });
  return {
    fileId: uploaded.fileID,
    contentType: type.contentType,
    revisedPrompt: first.revised_prompt || "",
  };
}

function safeImageError(error, apiKey) {
  let message = String((error && error.message) || "生图任务失败").replace(/\s+/g, " ").slice(0, 500);
  if (apiKey) message = message.split(String(apiKey)).join("[REDACTED]");
  return { message, statusCode: Number(error && error.statusCode) || 0 };
}

module.exports = {
  IMAGE_TIMEOUT_MS,
  ImageServiceError,
  generateImage,
  imageType,
  safeImageError,
  unsupportedParameter,
};
