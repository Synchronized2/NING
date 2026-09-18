const crypto = require("node:crypto");
const { buildEndpoint } = require("./security");
const { seal } = require("./secret-box");
const { publicTask } = require("./task-store");

const TASK_LIFETIME_MS = 20 * 60 * 1000;
const TASK_RECORD_MS = 24 * 60 * 60 * 1000;

function json(response, statusCode, body) {
  const encoded = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": encoded.length,
    "Cache-Control": "no-store",
  });
  response.end(encoded);
}

function ownerFromRequest(request) {
  const value = String(request.headers["x-wx-openid"] || "").trim();
  return /^[a-zA-Z0-9_-]{6,128}$/.test(value) ? value : "";
}

function readJson(request, maxBytes = 96 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    request.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(Object.assign(new Error("请求内容过大。"), { httpStatus: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (_) {
        reject(Object.assign(new Error("请求 JSON 格式无效。"), { httpStatus: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function text(value, name, maxLength, required = true) {
  const output = String(value || "").trim();
  if (required && !output) throw Object.assign(new Error(`${name}不能为空。`), { httpStatus: 400 });
  if (output.length > maxLength) throw Object.assign(new Error(`${name}过长。`), { httpStatus: 400 });
  return output;
}

function normalizeInput(body) {
  const input = {
    baseUrl: text(body.baseUrl, "服务 URL", 1000),
    apiKey: text(body.apiKey, "API Key", 2000),
    model: text(body.model, "生图模型", 300),
    prompt: text(body.prompt, "图片描述", 32000),
    size: text(body.size, "图片尺寸", 30, false),
    quality: text(body.quality, "图片质量", 30, false),
    style: text(body.style, "图片风格", 30, false),
  };
  try {
    buildEndpoint(input.baseUrl, "images/generations");
  } catch (error) {
    error.httpStatus = 400;
    throw error;
  }
  return input;
}

function taskIdFromPath(pathname) {
  const match = pathname.match(/^\/image\/tasks\/([a-f0-9-]{20,64})$/i);
  return match ? match[1] : "";
}

function createHttpHandler({ store, worker, encryptionSecret, ready }) {
  return async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      if (request.method === "GET" && url.pathname === "/health") {
        json(response, 200, { ok: true, service: "openaiq-image", ready: await ready.then(() => true, () => false) });
        return;
      }
      const owner = ownerFromRequest(request);
      if (!owner) {
        json(response, 401, { ok: false, error: "仅允许通过微信小程序云托管调用。", code: "UNAUTHORIZED" });
        return;
      }
      await ready;
      if (request.method === "POST" && url.pathname === "/image/tasks") {
        const input = normalizeInput(await readJson(request));
        const now = Date.now();
        const taskId = crypto.randomUUID();
        await store.create({
          _id: taskId,
          owner,
          status: "queued",
          encryptedPayload: seal(input, encryptionSecret),
          result: null,
          error: "",
          statusCode: 0,
          attempts: 0,
          leaseOwner: "",
          leaseUntil: 0,
          createdAt: now,
          updatedAt: now,
          startedAt: 0,
          completedAt: 0,
          expiresAt: now + TASK_LIFETIME_MS,
          purgeAt: now + TASK_RECORD_MS,
        });
        worker.kick();
        json(response, 202, { ok: true, data: { taskId, status: "queued" } });
        return;
      }
      const taskId = taskIdFromPath(url.pathname);
      if (taskId && request.method === "GET") {
        const task = await store.getOwned(taskId, owner);
        if (!task) {
          json(response, 404, { ok: false, error: "生图任务不存在。", code: "TASK_NOT_FOUND" });
          return;
        }
        json(response, 200, { ok: true, data: publicTask(task) });
        return;
      }
      if (taskId && request.method === "DELETE") {
        const result = await store.cancel(taskId, owner, Date.now());
        if (!result.existing) {
          json(response, 404, { ok: false, error: "生图任务不存在。", code: "TASK_NOT_FOUND" });
          return;
        }
        if (result.canceled) worker.cancel(taskId);
        const current = result.canceled ? await store.getOwned(taskId, owner) : result.existing;
        json(response, 200, { ok: true, data: publicTask(current) });
        return;
      }
      json(response, 404, { ok: false, error: "接口不存在。", code: "NOT_FOUND" });
    } catch (error) {
      const status = Number(error && error.httpStatus) || 500;
      const message = status >= 500 ? "生图任务服务暂时不可用。" : String(error.message || "请求失败").slice(0, 300);
      json(response, status, { ok: false, error: message, code: status >= 500 ? "SERVICE_ERROR" : "INVALID_REQUEST" });
    }
  };
}

module.exports = {
  TASK_LIFETIME_MS,
  createHttpHandler,
  normalizeInput,
  ownerFromRequest,
  taskIdFromPath,
};
