const IMAGE_MARKERS = ["image", "dall-e", "dalle", "flux", "stable-diffusion", "ideogram"];
const NON_CHAT_MARKERS = IMAGE_MARKERS.concat([
  "embedding",
  "moderation",
  "whisper",
  "transcribe",
  "speech",
  "tts",
  "realtime",
]);
const KNOWN_RESOURCES = [
  "/chat/completions",
  "/images/generations",
  "/images/edits",
  "/models",
];
const CODEX_CLIENT_ONLY_CODE = "CODEX_OFFICIAL_CLIENT_ONLY";
const CODEX_CLIENT_ONLY_PATTERN = /(?:this\s+account\s+)?only\s+allows?\s+codex\s+official\s+clients?/i;
function normalizeBaseUrl(baseUrl) {
  let normalized = String(baseUrl || "").trim();
  while (normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  const lower = normalized.toLowerCase();
  const known = KNOWN_RESOURCES.find((resource) => lower.endsWith(resource));
  if (known) normalized = normalized.slice(0, -known.length);
  while (normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  return normalized;
}

function isSecureBaseUrl(baseUrl) {
  const value = normalizeBaseUrl(baseUrl);
  const match = value.match(/^https:\/\/([^\s/?#]+)(?:\/[^\s?#]*)?$/i);
  if (!match || match[1].includes("@")) return false;
  const authority = match[1];
  if (authority.startsWith("[")) {
    return /^\[[0-9a-f:]+\](?::\d{1,5})?$/i.test(authority);
  }
  const parts = authority.split(":");
  if (parts.length > 2 || !parts[0]) return false;
  if (parts.length === 2) {
    const port = Number(parts[1]);
    if (!/^\d+$/.test(parts[1]) || port < 1 || port > 65535) return false;
  }
  return /^[a-z0-9.-]+$/i.test(parts[0]);
}

function buildApiEndpoint(baseUrl, resource) {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!isSecureBaseUrl(normalized)) throw makeError("请输入有效的 HTTPS 服务 URL。");
  const originMatch = normalized.match(/^https:\/\/[^/]+/i);
  const path = normalized.slice(originMatch[0].length);
  return path === "" || path === "/"
    ? `${normalized}/v1/${resource}`
    : `${normalized}/${resource}`;
}

function classifyModels(modelIds) {
  const unique = Array.from(new Set((modelIds || [])
    .map((item) => String(item || "").trim())
    .filter(Boolean)))
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  return {
    all: unique,
    image: unique.filter((model) => IMAGE_MARKERS.some((marker) => model.toLowerCase().includes(marker))),
    chat: unique.filter((model) => !NON_CHAT_MARKERS.some((marker) => model.toLowerCase().includes(marker))),
  };
}

function makeError(message, statusCode = 0, aborted = false) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.aborted = aborted;
  return error;
}

function parseJson(value) {
  if (value && typeof value === "object" && !(value instanceof ArrayBuffer)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return JSON.parse(value);
  } catch (_) {
    return null;
  }
}

function boundedText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 500);
}

function errorMessageFromBody(body) {
  if (body && typeof body === "object" && !(body instanceof ArrayBuffer)) {
    if (body.error) {
      if (typeof body.error === "string") return body.error;
      const nested = errorMessageFromBody(body.error);
      if (nested) return nested;
    }
    for (const key of ["message", "detail", "error_description"]) {
      if (typeof body[key] === "string" && body[key].trim()) return body[key];
    }
    return "";
  }
  if (typeof body !== "string" || !body.trim()) return "";
  const parsed = parseJson(body);
  if (parsed) return errorMessageFromBody(parsed);
  for (const line of body.split(/\r?\n/)) {
    const payload = line.replace(/^\s*data:\s*/i, "").trim();
    if (!payload || payload === "[DONE]" || payload === body.trim()) continue;
    const lineParsed = parseJson(payload);
    if (lineParsed) {
      const message = errorMessageFromBody(lineParsed);
      if (message) return message;
    }
  }
  const field = body.match(/"(?:message|detail|error_description)"\s*:\s*"((?:\\.|[^"\\])*)"/i);
  if (field) {
    try { return JSON.parse(`"${field[1]}"`); } catch (_) { return field[1]; }
  }
  return body;
}

function codexClientOnlyError(value, statusCode = 0) {
  let searchable = typeof value === "string" ? value : "";
  if (!searchable && value) {
    try { searchable = JSON.stringify(value); } catch (_) {}
  }
  if (!CODEX_CLIENT_ONLY_PATTERN.test(searchable)) return null;
  const error = makeError(
    "当前账号只允许 Codex 官方客户端调用，NING 无法使用这个 API Key。请更换支持标准 API 调用的账号、Key 或模型节点。",
    statusCode || 403,
  );
  error.code = CODEX_CLIENT_ONLY_CODE;
  return error;
}

function isCodexOnlyClientError(error) {
  return Boolean(error && (error.code === CODEX_CLIENT_ONLY_CODE ||
    CODEX_CLIENT_ONLY_PATTERN.test(String(error.message || error))));
}

function apiError(statusCode, body, apiKey) {
  const restricted = codexClientOnlyError(body, statusCode);
  if (restricted) return restricted;
  let message = errorMessageFromBody(body);
  message = boundedText(message) || "模型服务请求失败";
  if (apiKey) message = message.split(apiKey).join("[REDACTED]");
  return makeError(`HTTP ${statusCode}：${message}`, statusCode);
}

function authHeaders(apiKey, accept = "application/json") {
  return {
    Accept: accept,
    Authorization: `Bearer ${String(apiKey || "").trim()}`,
    "Content-Type": "application/json; charset=utf-8",
  };
}

function fileKind(filePath, fallback = "application/octet-stream") {
  const clean = String(filePath || "").split("?")[0].toLowerCase();
  if (clean.endsWith(".jpg") || clean.endsWith(".jpeg")) return { extension: "jpg", mimeType: "image/jpeg" };
  if (clean.endsWith(".webp")) return { extension: "webp", mimeType: "image/webp" };
  if (clean.endsWith(".png")) return { extension: "png", mimeType: "image/png" };
  return { extension: "jpg", mimeType: fallback };
}

function uploadCloudFile(filePath, folder, fallbackType) {
  let task = null;
  let aborted = false;
  const kind = fileKind(filePath, fallbackType);
  const promise = new Promise((resolve, reject) => {
    if (!wx.cloud || !wx.cloud.uploadFile) {
      reject(makeError("当前微信环境不支持云文件上传。"));
      return;
    }
    task = wx.cloud.uploadFile({
      cloudPath: `openaiq-input/${folder}/${Date.now()}-${Math.random().toString(16).slice(2)}.${kind.extension}`,
      filePath,
      success: (result) => resolve({ fileId: result.fileID, mimeType: kind.mimeType }),
      fail: (error) => reject(makeError(aborted ? "请求已停止" : `文件上传失败：${boundedText(error.errMsg)}`, 0, aborted)),
    });
  });
  return {
    promise,
    abort() {
      aborted = true;
      if (task && task.abort) task.abort();
    },
  };
}

function readDataUrl(filePath, fallbackType = "image/jpeg") {
  const kind = fileKind(filePath, fallbackType);
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath,
      encoding: "base64",
      success: (result) => {
        if (String(result.data || "").length > 14 * 1024 * 1024) {
          reject(makeError("图片超过 10 MB，无法作为对话附件。"));
          return;
        }
        resolve({ dataUrl: `data:${kind.mimeType};base64,${result.data}`, mimeType: kind.mimeType });
      },
      fail: (error) => reject(makeError(`读取文件失败：${boundedText(error.errMsg)}`)),
    });
  });
}

function prepareImageAttachment(filePath, useCloudProxy = true) {
  if (useCloudProxy) {
    const operation = uploadCloudFile(filePath, "vision", "image/jpeg");
    return {
      abort: operation.abort,
      promise: operation.promise.then((result) => ({ ...result, localPath: filePath })),
    };
  }
  return {
    abort() {},
    promise: readDataUrl(filePath, "image/jpeg").then((result) => ({ ...result, localPath: filePath })),
  };
}

function requestJson({ baseUrl, apiKey, resource, method = "GET", data, timeout = 30000 }) {
  let task = null;
  let abortRequested = false;
  const promise = new Promise((resolve, reject) => {
    task = wx.request({
      url: buildApiEndpoint(baseUrl, resource),
      method,
      data,
      timeout,
      header: authHeaders(apiKey),
      success(response) {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(apiError(response.statusCode, response.data, apiKey));
          return;
        }
        const parsed = parseJson(response.data);
        if (!parsed) {
          reject(makeError("模型服务返回了无法解析的 JSON。", response.statusCode));
          return;
        }
        resolve(parsed);
      },
      fail(error) {
        if (abortRequested || String(error.errMsg || "").includes("abort")) {
          reject(makeError("请求已停止", 0, true));
          return;
        }
        reject(makeError(`网络请求失败：${boundedText(error.errMsg) || "请检查服务地址和网络"}`));
      },
    });
  });
  return {
    promise,
    abort() {
      abortRequested = true;
      if (task) task.abort();
    },
  };
}

function isRetryableTtsError(error) {
  if (!error || error.aborted) return false;
  const statusCode = Number(error.statusCode || error.errCode || 0);
  if ([408, 425, 429, 500, 502, 503, 504, -501000].includes(statusCode)) return true;
  const message = String(error.message || error.errMsg || "").toLowerCase();
  return /functionname|function_not_found|timeout|timed out|network|socket|connect|temporar|system error|econn|502|503|504/.test(message);
}

function cloudInvocationError(action, error) {
  const reason = boundedText(error && (error.errMsg || error.message));
  const statusCode = Number(error && (error.errCode || error.statusCode) || 0);
  if (statusCode === -504003 || /invoking task timed out|function.*timed out/i.test(reason)) {
    const message = action === "image"
      ? "中转生图已达到微信云函数 60 秒上限；请切换直连模式，或使用能在 60 秒内返回的生图节点。"
      : "云函数请求已达到微信平台 60 秒执行上限。";
    return makeError(message, statusCode);
  }
  const isTtsAction = action === "tts" || action === "ttsVoices";
  const message = isTtsAction
    ? `Edge TTS 免费且不使用模型 API Key。朗读云函数调用失败，请重新上传并部署中转云函数（选择“云端安装依赖”）。${reason ? ` ${reason}` : ""}`
    : `云函数调用失败：${reason}`;
  return makeError(message, statusCode);
}

function callCloudProxy(action, data) {
  const isTtsAction = action === "tts" || action === "ttsVoices";
  const maxRetries = isTtsAction ? 3 : 0;
  const retryDelays = [200, 400, 800];
  let settled = false;
  let rejectPending = null;
  let resolvePending = null;
  let retryTimer = null;

  const cleanupLateResponse = (response) => {
    const fileId = response && response.result && response.result.ok && response.result.data && response.result.data.fileId;
    if ((action === "tts" || action === "image") && fileId && wx.cloud && wx.cloud.deleteFile) {
      try {
        const cleanup = wx.cloud.deleteFile({ fileList: [fileId], fail() {} });
        if (cleanup && cleanup.catch) cleanup.catch(() => {});
      } catch (_) {}
    }
  };

  const finishWithError = (error, attempt) => {
    if (settled) return;
    if (isTtsAction && attempt <= maxRetries && isRetryableTtsError(error)) {
      const delay = retryDelays[Math.min(attempt - 1, retryDelays.length - 1)];
      retryTimer = setTimeout(() => {
        retryTimer = null;
        runAttempt(attempt + 1);
      }, delay);
      return;
    }
    settled = true;
    rejectPending(error);
  };

  const runAttempt = (attempt) => {
    if (settled) return;
    let invocation;
    try {
      invocation = wx.cloud.callFunction({
        name: "openaiProxy",
        data: { action, ...data },
      });
    } catch (error) {
      finishWithError(makeError(
        `云函数调用失败：${boundedText(error.message || error.errMsg)}`,
        Number(error.errCode || error.statusCode || 0),
      ), attempt);
      return;
    }
    Promise.resolve(invocation).then((response) => {
      if (settled) {
        cleanupLateResponse(response);
        return;
      }
      const result = response && response.result;
      if (!result || result.ok !== true) {
        const reason = result && result.error
          ? result.error
          : "云函数没有返回有效结果，请确认中转云函数已上传并部署。";
        const message = isTtsAction
          ? `Edge TTS 免费且不使用模型 API Key。${reason}`
          : reason;
        const statusCode = (result && result.statusCode) || 0;
        const error = codexClientOnlyError(reason, statusCode) || makeError(message, statusCode);
        finishWithError(error, attempt);
        return;
      }
      settled = true;
      resolvePending(result.data);
    }).catch((error) => {
      if (settled) return;
      finishWithError(cloudInvocationError(action, error), attempt);
    });
  };

  const promise = new Promise((resolve, reject) => {
    resolvePending = resolve;
    rejectPending = reject;
    if (!wx.cloud || !wx.cloud.callFunction) {
      settled = true;
      reject(makeError(isTtsAction
        ? "Edge TTS 免费且不使用模型 API Key，但需要先初始化微信云开发。"
        : "当前微信环境不支持云开发，请切换直连模式。"));
      return;
    }
    runAttempt(1);
  });
  return {
    promise,
    abort() {
      if (settled) return;
      settled = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      if (rejectPending) rejectPending(makeError("请求已停止", 0, true));
    },
  };
}

function listModels({ baseUrl, apiKey, useCloudProxy = true }) {
  const operation = useCloudProxy
    ? callCloudProxy("models", { baseUrl, apiKey })
    : requestJson({ baseUrl, apiKey, resource: "models" });
  return {
    abort: operation.abort,
    promise: operation.promise.then((response) => {
      const data = Array.isArray(response.models) ? response.models : response.data;
      if (!Array.isArray(data)) throw makeError("模型列表响应中缺少 data 字段。");
      const ids = data
        .map((item) => typeof item === "string" ? item : item && item.id)
        .filter(Boolean);
      const classified = classifyModels(ids);
      if (!classified.all.length) throw makeError("服务没有返回可用模型，你仍可手工填写模型名称。");
      return classified;
    }),
  };
}

class Utf8StreamDecoder {
  constructor() {
    this.pending = [];
  }

  push(input, final = false) {
    const incoming = input instanceof Uint8Array ? input : new Uint8Array(input || 0);
    const bytes = new Uint8Array(this.pending.length + incoming.length);
    bytes.set(this.pending, 0);
    bytes.set(incoming, this.pending.length);
    this.pending = [];
    let output = "";
    let index = 0;
    while (index < bytes.length) {
      const first = bytes[index];
      let needed = 0;
      let codePoint = 0;
      if (first < 0x80) {
        output += String.fromCharCode(first);
        index += 1;
        continue;
      } else if (first >= 0xc2 && first <= 0xdf) {
        needed = 1;
        codePoint = first & 0x1f;
      } else if (first >= 0xe0 && first <= 0xef) {
        needed = 2;
        codePoint = first & 0x0f;
      } else if (first >= 0xf0 && first <= 0xf4) {
        needed = 3;
        codePoint = first & 0x07;
      } else {
        output += "\ufffd";
        index += 1;
        continue;
      }
      if (index + needed >= bytes.length) {
        if (!final) {
          this.pending = Array.from(bytes.slice(index));
          break;
        }
        output += "\ufffd";
        break;
      }
      let valid = true;
      for (let offset = 1; offset <= needed; offset += 1) {
        const next = bytes[index + offset];
        if ((next & 0xc0) !== 0x80) {
          valid = false;
          break;
        }
        codePoint = (codePoint << 6) | (next & 0x3f);
      }
      if (!valid || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
        output += "\ufffd";
        index += 1;
        continue;
      }
      if (codePoint <= 0xffff) {
        output += String.fromCharCode(codePoint);
      } else {
        const adjusted = codePoint - 0x10000;
        output += String.fromCharCode(0xd800 + (adjusted >> 10), 0xdc00 + (adjusted & 0x3ff));
      }
      index += needed + 1;
    }
    return output;
  }
}

class SseDecoder {
  constructor(onData) {
    this.buffer = "";
    this.onData = onData;
    this.trailingCarriageReturn = false;
  }

  push(text, final = false) {
    let incoming = String(text || "");
    if (this.trailingCarriageReturn) {
      incoming = `\r${incoming}`;
      this.trailingCarriageReturn = false;
    }
    if (!final && incoming.endsWith("\r")) {
      incoming = incoming.slice(0, -1);
      this.trailingCarriageReturn = true;
    }
    if (final && this.trailingCarriageReturn) {
      incoming += "\r";
      this.trailingCarriageReturn = false;
    }
    this.buffer += incoming.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    let boundary = this.buffer.indexOf("\n\n");
    while (boundary >= 0) {
      this.emit(this.buffer.slice(0, boundary));
      this.buffer = this.buffer.slice(boundary + 2);
      boundary = this.buffer.indexOf("\n\n");
    }
    if (final && this.buffer.trim()) {
      this.emit(this.buffer);
      this.buffer = "";
    }
  }

  emit(eventBlock) {
    const data = eventBlock
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data) this.onData(data);
  }
}

class ToolAccumulator {
  constructor() {
    this.items = {};
  }

  accept(toolCalls) {
    if (!Array.isArray(toolCalls)) return;
    toolCalls.forEach((call, arrayIndex) => {
      if (!call) return;
      const index = Number.isInteger(call.index) ? call.index : arrayIndex;
      if (!this.items[index]) this.items[index] = { id: "", name: "", arguments: "" };
      const item = this.items[index];
      if (call.id) item.id = call.id;
      const fn = call.function || {};
      if (fn.name) item.name += fn.name;
      if (fn.arguments) item.arguments += fn.arguments;
    });
  }

  values() {
    return Object.keys(this.items)
      .sort((a, b) => Number(a) - Number(b))
      .map((key) => this.items[key])
      .filter((item) => item.name);
  }
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && (part.type === "text" || typeof part.text === "string"))
    .map((part) => part.text || "")
    .join("");
}

function extractCompletion(response, accumulator) {
  if (response && response.error) {
    const message = typeof response.error === "string" ? response.error : response.error.message;
    throw codexClientOnlyError(message, 403) || makeError(boundedText(message) || "模型节点返回错误");
  }
  const choice = response && Array.isArray(response.choices) ? response.choices[0] : null;
  if (!choice) return "";
  const body = choice.delta || choice.message || {};
  accumulator.accept(body.tool_calls);
  return contentToText(body.content);
}

function createCloudChatCompletion({ baseUrl, apiKey, model, messages, tools, onDelta }) {
  const operation = callCloudProxy("chat", {
    baseUrl,
    apiKey,
    model,
    messages,
    enableImageTool: tools.length > 0,
  });
  return {
    abort: operation.abort,
    promise: operation.promise.then((result) => {
      const accumulator = new ToolAccumulator();
      const text = extractCompletion(result.response || result, accumulator);
      if (text) onDelta(text);
      const response = result.response || result;
      return { text, toolCalls: accumulator.values(), usage: response.usage || null };
    }),
  };
}

function createChatCompletion({
  baseUrl,
  apiKey,
  model,
  messages,
  tools = [],
  onDelta = () => {},
  useCloudProxy = true,
}) {
  if (useCloudProxy) {
    return createCloudChatCompletion({ baseUrl, apiKey, model, messages, tools, onDelta });
  }
  let task = null;
  let abortRequested = false;
  let settled = false;
  const promise = new Promise((resolve, reject) => {
    const utf8 = new Utf8StreamDecoder();
    const accumulator = new ToolAccumulator();
    let rawText = "";
    let output = "";
    let eventCount = 0;
    let streamError = null;
    let usage = null;
    const consume = (data) => {
      if (data === "[DONE]") return;
      const payload = parseJson(data);
      if (!payload) return;
      eventCount += 1;
      if (payload.usage) usage = payload.usage;
      const delta = extractCompletion(payload, accumulator);
      if (delta) {
        output += delta;
        onDelta(delta);
      }
    };
    const sse = new SseDecoder((data) => {
      try {
        consume(data);
      } catch (error) {
        streamError = error;
        if (task) task.abort();
      }
    });
    const payload = { model, messages, stream: true };
    if (tools.length) {
      payload.tools = tools;
      payload.tool_choice = "auto";
    }
    task = wx.request({
      url: buildApiEndpoint(baseUrl, "chat/completions"),
      method: "POST",
      data: payload,
      timeout: 120000,
      enableChunked: true,
      header: authHeaders(apiKey, "text/event-stream, application/json"),
      success(response) {
        if (settled) return;
        settled = true;
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(apiError(response.statusCode, response.data || rawText, apiKey));
          return;
        }
        const tail = utf8.push(new Uint8Array(0), true);
        if (tail) {
          rawText += tail;
          sse.push(tail);
        }
        sse.push("", true);
        if (!eventCount && typeof response.data === "string" && response.data.includes("data:")) {
          sse.push(response.data, true);
        }
        if (streamError) {
          reject(streamError);
          return;
        }
        if (!eventCount) {
          const responseBody = parseJson(response.data) || parseJson(rawText);
          if (!responseBody) {
            reject(makeError("模型服务返回了无法解析的响应。", response.statusCode));
            return;
          }
          try {
            if (responseBody.usage) usage = responseBody.usage;
            const text = extractCompletion(responseBody, accumulator);
            if (text) {
              output += text;
              onDelta(text);
            }
          } catch (error) {
            reject(error);
            return;
          }
        }
        resolve({ text: output, toolCalls: accumulator.values(), usage });
      },
      fail(error) {
        if (settled) return;
        settled = true;
        if (streamError) {
          reject(streamError);
        } else if (abortRequested || String(error.errMsg || "").includes("abort")) {
          reject(makeError("请求已停止", 0, true));
        } else {
          reject(makeError(`网络请求失败：${boundedText(error.errMsg) || "请检查服务地址和网络"}`));
        }
      },
    });
    if (task.onChunkReceived) {
      task.onChunkReceived((chunk) => {
        const text = utf8.push(chunk.data);
        rawText += text;
        sse.push(text);
      });
    }
  });
  return {
    promise,
    abort() {
      abortRequested = true;
      if (task) task.abort();
    },
  };
}

function unsupportedImageParameter(error, parameter) {
  if (!error || Number(error.statusCode) !== 400) return false;
  const message = String(error.message || "").toLowerCase();
  if (!message.includes(parameter.toLowerCase())) return false;
  return /unknown|unsupported|not supported|unrecognized|invalid (?:value|parameter|argument)/.test(message);
}

function imageRequest(options, parameters) {
  const { baseUrl, apiKey, model, prompt, useCloudProxy } = options;
  const { size, quality, style } = parameters;
  return useCloudProxy
    ? callCloudProxy("image", { baseUrl, apiKey, model, prompt, size, quality, style })
    : requestJson({
      baseUrl,
      apiKey,
      resource: "images/generations",
      method: "POST",
      timeout: 600000,
      data: {
        model,
        prompt,
        n: 1,
        ...(size ? { size } : {}),
        ...(quality ? { quality } : {}),
        ...(style ? { style } : {}),
      },
    });
}

function normalizeImageResponse(response) {
  if (response.fileId) {
    return {
      fileId: response.fileId,
      base64: "",
      url: "",
      revisedPrompt: response.revisedPrompt || "",
    };
  }
  const first = response && Array.isArray(response.data) ? response.data[0] : null;
  if (!first) throw makeError("节点没有返回图片数据。");
  if (!first.b64_json && !first.url) throw makeError("生图响应中没有 b64_json 或 url 字段。");
  if (first.url && !/^https:\/\//i.test(first.url)) throw makeError("节点返回了不安全的图片地址。");
  return {
    base64: first.b64_json || "",
    url: first.url || "",
    revisedPrompt: first.revised_prompt || "",
  };
}

function createImage({ baseUrl, apiKey, model, prompt, size, quality, style, useCloudProxy = true }) {
  const options = { baseUrl, apiKey, model, prompt, useCloudProxy };
  const parameters = { size, quality, style };
  let activeOperation = null;
  let aborted = false;
  const promise = (async () => {
    while (true) {
      if (aborted) throw makeError("请求已停止", 0, true);
      activeOperation = imageRequest(options, parameters);
      try {
        return normalizeImageResponse(await activeOperation.promise);
      } catch (error) {
        if (aborted || error.aborted) throw makeError("请求已停止", 0, true);
        if (parameters.style && unsupportedImageParameter(error, "style")) {
          parameters.style = "";
          continue;
        }
        if (parameters.quality && unsupportedImageParameter(error, "quality")) {
          parameters.quality = "";
          continue;
        }
        throw error;
      }
    }
  })();
  return {
    promise,
    abort() {
      aborted = true;
      if (activeOperation && activeOperation.abort) activeOperation.abort();
    },
  };
}

function listTtsVoices() {
  const operation = callCloudProxy("ttsVoices", {});
  return {
    abort: operation.abort,
    promise: operation.promise.then((response) => {
      if (!response || !Array.isArray(response.voices)) throw makeError("Edge TTS 没有返回人声列表。");
      return response.voices;
    }),
  };
}

function synthesizeSpeech({ text, voice, rate = 0, volume = 0, pitch = 0 }) {
  const operation = callCloudProxy("tts", { text, voice, rate, volume, pitch });
  return {
    abort: operation.abort,
    promise: operation.promise.then((response) => {
      if (!response || (!response.fileId && !response.localPath)) throw makeError("Edge TTS 没有返回音频文件。");
      return response;
    }),
  };
}

function imageExtension(base64) {
  const compact = String(base64 || "").replace(/\s/g, "");
  if (compact.startsWith("/9j/")) return "jpg";
  if (compact.startsWith("UklGR")) return "webp";
  return "png";
}

function materializeImage(response) {
  if (response.fileId) return Promise.resolve({ url: response.fileId, persistent: true });
  if (response.url) return Promise.resolve({ url: response.url, persistent: false });
  const base64 = String(response.base64 || "").replace(/^data:image\/[^;]+;base64,/, "").replace(/\s/g, "");
  if (!base64) return Promise.reject(makeError("图片 Base64 数据为空。"));
  if (typeof wx === "undefined" || !wx.getFileSystemManager || !wx.env) {
    return Promise.reject(makeError("当前环境无法保存生成图片。"));
  }
  const filePath = `${wx.env.USER_DATA_PATH}/openaiq-${Date.now()}.${imageExtension(base64)}`;
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().writeFile({
      filePath,
      data: base64,
      encoding: "base64",
      success: () => resolve({ url: filePath, persistent: true }),
      fail: (error) => reject(makeError(`保存生成图片失败：${boundedText(error.errMsg)}`)),
    });
  });
}

function parseImageToolCall(call) {
  if (!call || call.name !== "generate_image") return null;
  try {
    const parameters = JSON.parse(call.arguments || "{}");
    const prompt = typeof parameters.prompt === "string" ? parameters.prompt.trim() : "";
    return prompt ? { id: call.id || "", name: call.name, prompt } : null;
  } catch (_) {
    return null;
  }
}

module.exports = {
  SseDecoder,
  ToolAccumulator,
  Utf8StreamDecoder,
  buildApiEndpoint,
  classifyModels,
  contentToText,
  createChatCompletion,
  createImage,
  isSecureBaseUrl,
  isCodexOnlyClientError,
  listModels,
  listTtsVoices,
  materializeImage,
  normalizeBaseUrl,
  parseImageToolCall,
  prepareImageAttachment,
  synthesizeSpeech,
};
