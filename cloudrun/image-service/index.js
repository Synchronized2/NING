const http = require("node:http");
const cloudbase = require("@cloudbase/node-sdk");
const { cloudbaseConfig } = require("./lib/cloudbase-config");
const { createHttpHandler } = require("./lib/http-app");
const { TaskStore } = require("./lib/task-store");
const { TaskWorker } = require("./lib/task-worker");

const port = Math.max(1, Number(process.env.PORT) || 80);
const encryptionSecret = String(process.env.TASK_ENCRYPTION_KEY || "");
const environment = process.env.CLOUDBASE_ENV_ID || "cloudbase-d2gg15kzjf02a74ab";
const app = cloudbase.init(cloudbaseConfig(environment));
const store = new TaskStore(app.database(), process.env.IMAGE_TASK_COLLECTION || "openaiq_image_tasks");
const worker = new TaskWorker({
  store,
  cloudbase: app,
  encryptionSecret,
  concurrency: Math.max(1, Math.min(4, Number(process.env.IMAGE_WORKER_CONCURRENCY) || 2)),
});

const ready = (async () => {
  if (encryptionSecret.length < 32) throw new Error("TASK_ENCRYPTION_KEY 必须至少包含 32 个字符。");
  await store.ensureCollection();
  worker.start();
  return true;
})();

ready.catch((error) => console.error("image service initialization failed", String(error && error.message || error)));

const server = http.createServer(createHttpHandler({
  store,
  worker,
  encryptionSecret,
  ready,
}));
server.headersTimeout = 10000;
server.requestTimeout = 15000;
server.keepAliveTimeout = 5000;
server.listen(port, () => console.log(`openaiq-image listening on ${port}`));

function shutdown() {
  worker.stop();
  server.close(() => process.exit(0));
  const timer = setTimeout(() => process.exit(0), 8000);
  if (timer.unref) timer.unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
