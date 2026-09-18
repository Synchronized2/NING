const crypto = require("node:crypto");
const { IMAGE_TIMEOUT_MS, ImageServiceError, generateImage, safeImageError } = require("./image-generator");
const { open } = require("./secret-box");

const LEASE_MS = 90000;
const HEARTBEAT_MS = 30000;

class TaskWorker {
  constructor({ store, cloudbase, encryptionSecret, logger = console, concurrency = 2, generate = generateImage }) {
    this.store = store;
    this.cloudbase = cloudbase;
    this.encryptionSecret = encryptionSecret;
    this.logger = logger;
    this.concurrency = concurrency;
    this.generate = generate;
    this.instanceId = `${process.env.HOSTNAME || "local"}-${crypto.randomBytes(6).toString("hex")}`;
    this.active = new Map();
    this.scanPromise = null;
    this.scanTimer = null;
    this.lastPurgeAt = 0;
  }

  start() {
    if (this.scanTimer) return;
    this.scanTimer = setInterval(() => this.kick(), 3000);
    if (this.scanTimer.unref) this.scanTimer.unref();
    this.kick();
  }

  stop() {
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.scanTimer = null;
  }

  cancel(taskId) {
    const controller = this.active.get(taskId);
    if (controller) controller.abort();
  }

  kick() {
    if (this.scanPromise || this.active.size >= this.concurrency) return;
    this.scanPromise = this.scan().catch((error) => {
      this.logger.error("image worker scan failed", String(error && error.message || error));
    }).finally(() => {
      this.scanPromise = null;
    });
  }

  async scan() {
    const now = Date.now();
    if (now - this.lastPurgeAt >= 60 * 60 * 1000) {
      this.lastPurgeAt = now;
      await this.store.purge(now).catch((error) => {
        this.logger.error("image worker purge failed", String(error && error.message || error));
      });
    }
    const capacity = this.concurrency - this.active.size;
    if (capacity <= 0) return;
    const tasks = await this.store.listRecoverable(now, capacity);
    for (const task of tasks) {
      if (this.active.size >= this.concurrency) break;
      const leaseOwner = `${this.instanceId}:${task._id}`;
      const claimed = await this.store.claim(task._id, leaseOwner, Date.now(), LEASE_MS);
      if (claimed) this.run(claimed, leaseOwner);
    }
  }

  async run(task, leaseOwner) {
    const controller = new AbortController();
    this.active.set(task._id, controller);
    let input = null;
    let generated = null;
    const executionTimeout = setTimeout(() => {
      controller.abort(new ImageServiceError("生图服务等待超过 10 分钟。", 504));
    }, IMAGE_TIMEOUT_MS);
    if (executionTimeout.unref) executionTimeout.unref();
    const heartbeat = setInterval(async () => {
      try {
        const owned = await this.store.heartbeat(task._id, leaseOwner, Date.now(), LEASE_MS);
        if (!owned) controller.abort();
      } catch (error) {
        this.logger.error("image worker heartbeat failed", task._id, String(error && error.message || error));
      }
    }, HEARTBEAT_MS);
    if (heartbeat.unref) heartbeat.unref();
    try {
      input = open(task.encryptedPayload, this.encryptionSecret);
      generated = await this.generate(input, {
        cloudbase: this.cloudbase,
        owner: task.owner,
        taskId: task._id,
        signal: controller.signal,
      });
      const saved = await this.store.finishSuccess(task._id, leaseOwner, generated, Date.now());
      if (!saved && generated.fileId) {
        await this.cloudbase.deleteFile({ fileList: [generated.fileId] }).catch(() => {});
      }
    } catch (error) {
      const safe = safeImageError(error, input && input.apiKey);
      await this.store.finishFailure(task._id, leaseOwner, safe, Date.now()).catch((storeError) => {
        this.logger.error("image worker could not save failure", task._id, String(storeError && storeError.message || storeError));
      });
      if (generated && generated.fileId) {
        await this.cloudbase.deleteFile({ fileList: [generated.fileId] }).catch(() => {});
      }
    } finally {
      clearTimeout(executionTimeout);
      clearInterval(heartbeat);
      this.active.delete(task._id);
      this.kick();
    }
  }
}

module.exports = { HEARTBEAT_MS, LEASE_MS, TaskWorker };
