const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { cloudbaseConfig } = require("../lib/cloudbase-config");
const { createHttpHandler, normalizeInput, ownerFromRequest, taskIdFromPath } = require("../lib/http-app");
const { IMAGE_TIMEOUT_MS, imageType, safeImageError, unsupportedParameter } = require("../lib/image-generator");
const { open, seal } = require("../lib/secret-box");
const { buildEndpoint, isPrivateIp } = require("../lib/security");
const { publicTask } = require("../lib/task-store");
const { TaskWorker } = require("../lib/task-worker");

const SECRET = "test-only-secret-with-at-least-32-characters";

test("cloud hosting uses an environment-scoped server API key", () => {
  assert.deepEqual(cloudbaseConfig("env-test", { CLOUDBASE_APIKEY: " server-key " }), {
    env: "env-test",
    accessKey: "server-key",
  });
  assert.throws(
    () => cloudbaseConfig("env-test", {}),
    /CLOUDBASE_APIKEY.*API Key/,
  );
});

test("task credentials are authenticated-encrypted and require the server secret", () => {
  const value = { apiKey: "sk-private", prompt: "山水" };
  const encrypted = seal(value, SECRET);
  assert.equal(JSON.stringify(encrypted).includes("sk-private"), false);
  assert.deepEqual(open(encrypted, SECRET), value);
  assert.throws(() => open(encrypted, `${SECRET}-wrong`));
});

test("image endpoints reject private networks and normalize compatible base URLs", () => {
  assert.equal(buildEndpoint("https://api.example.com/v1", "images/generations").href,
    "https://api.example.com/v1/images/generations");
  assert.equal(isPrivateIp("127.0.0.1"), true);
  assert.equal(isPrivateIp("169.254.169.254"), true);
  assert.equal(isPrivateIp("8.8.8.8"), false);
  assert.throws(() => normalizeInput({
    baseUrl: "http://example.com",
    apiKey: "secret",
    model: "image-model",
    prompt: "test",
  }), /HTTPS/);
});

test("image processing keeps ten-minute timeout and redacts API keys", () => {
  assert.equal(IMAGE_TIMEOUT_MS, 600000);
  assert.equal(imageType(Buffer.from([0xff, 0xd8, 0xff])).extension, "jpg");
  const error = Object.assign(new Error("request failed with sk-secret"), { statusCode: 400 });
  assert.deepEqual(safeImageError(error, "sk-secret"), {
    message: "request failed with [REDACTED]",
    statusCode: 400,
  });
  assert.equal(unsupportedParameter(Object.assign(new Error("Unsupported parameter: style"), { statusCode: 400 }), "style"), true);
});

test("public task responses never expose ownership, leases, or encrypted credentials", () => {
  const output = publicTask({
    _id: "12345678-1234-1234-1234-123456789012",
    owner: "openid-secret",
    status: "running",
    encryptedPayload: { data: "ciphertext" },
    leaseOwner: "instance-secret",
    createdAt: 1,
  });
  assert.equal(output.taskId, "12345678-1234-1234-1234-123456789012");
  assert.equal(Object.hasOwn(output, "owner"), false);
  assert.equal(Object.hasOwn(output, "encryptedPayload"), false);
  assert.equal(Object.hasOwn(output, "leaseOwner"), false);
});

test("request helpers accept only injected OpenID and valid task paths", () => {
  assert.equal(ownerFromRequest({ headers: { "x-wx-openid": "openid_123456" } }), "openid_123456");
  assert.equal(ownerFromRequest({ headers: {} }), "");
  assert.equal(taskIdFromPath("/image/tasks/12345678-1234-1234-1234-123456789012"), "12345678-1234-1234-1234-123456789012");
  assert.equal(taskIdFromPath("/image/tasks/../../secret"), "");
});

function request(server, { method = "GET", path = "/", headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const address = server.address();
    const req = http.request({ host: "127.0.0.1", port: address.port, method, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ statusCode: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

test("task API authenticates callers and returns before background processing", async (context) => {
  const tasks = new Map();
  let kicks = 0;
  const store = {
    async create(task) { tasks.set(task._id, task); },
    async getOwned(id, owner) {
      const task = tasks.get(id);
      return task && task.owner === owner ? task : null;
    },
    async cancel() { return { canceled: false, existing: null }; },
  };
  const worker = { kick() { kicks += 1; }, cancel() {} };
  const server = http.createServer(createHttpHandler({
    store,
    worker,
    encryptionSecret: SECRET,
    ready: Promise.resolve(true),
  }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const denied = await request(server, { method: "POST", path: "/image/tasks", body: {} });
  assert.equal(denied.statusCode, 401);

  const created = await request(server, {
    method: "POST",
    path: "/image/tasks",
    headers: { "x-wx-openid": "openid_123456", "content-type": "application/json" },
    body: {
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-private",
      model: "image-model",
      prompt: "云海",
    },
  });
  assert.equal(created.statusCode, 202);
  assert.equal(created.body.data.status, "queued");
  assert.equal(kicks, 1);
  const taskId = created.body.data.taskId;
  assert.equal(JSON.stringify(tasks.get(taskId).encryptedPayload).includes("sk-private"), false);

  const status = await request(server, {
    path: `/image/tasks/${taskId}`,
    headers: { "x-wx-openid": "openid_123456" },
  });
  assert.equal(status.statusCode, 200);
  assert.equal(status.body.data.status, "queued");

  const otherUser = await request(server, {
    path: `/image/tasks/${taskId}`,
    headers: { "x-wx-openid": "another_openid" },
  });
  assert.equal(otherUser.statusCode, 404);
});

function workerStore(overrides = {}) {
  return {
    async listRecoverable() { return []; },
    async purge() { return 0; },
    async heartbeat() { return true; },
    async finishSuccess() { return true; },
    async finishFailure() { return true; },
    ...overrides,
  };
}

test("worker decrypts a leased task and persists only its generated result", async () => {
  let saved = null;
  const store = workerStore({
    async finishSuccess(taskId, leaseOwner, result) {
      saved = { taskId, leaseOwner, result };
      return true;
    },
  });
  const worker = new TaskWorker({
    store,
    cloudbase: { deleteFile: async () => {} },
    encryptionSecret: SECRET,
    logger: { error() {} },
    generate: async (input, context) => {
      assert.equal(input.apiKey, "sk-private");
      assert.equal(context.owner, "openid_123456");
      return { fileId: "cloud://generated.png" };
    },
  });
  await worker.run({
    _id: "task-success",
    owner: "openid_123456",
    encryptedPayload: seal({ apiKey: "sk-private", prompt: "云海" }, SECRET),
  }, "lease-success");
  assert.deepEqual(saved, {
    taskId: "task-success",
    leaseOwner: "lease-success",
    result: { fileId: "cloud://generated.png" },
  });
});

test("worker redacts an API key before persisting a task failure", async () => {
  let savedError = null;
  const store = workerStore({
    async finishFailure(_taskId, _leaseOwner, error) {
      savedError = error;
      return true;
    },
  });
  const worker = new TaskWorker({
    store,
    cloudbase: { deleteFile: async () => {} },
    encryptionSecret: SECRET,
    logger: { error() {} },
    generate: async () => {
      throw Object.assign(new Error("upstream rejected sk-private"), { statusCode: 401 });
    },
  });
  await worker.run({
    _id: "task-failure",
    owner: "openid_123456",
    encryptedPayload: seal({ apiKey: "sk-private", prompt: "云海" }, SECRET),
  }, "lease-failure");
  assert.deepEqual(savedError, { message: "upstream rejected [REDACTED]", statusCode: 401 });
});
