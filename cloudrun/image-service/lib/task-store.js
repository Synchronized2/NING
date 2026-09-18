function firstDocument(result) {
  return result && Array.isArray(result.data) ? result.data[0] || null : null;
}

function updateCount(result) {
  return Number(result && (result.updated || result.modifiedCount || (result.stats && result.stats.updated))) || 0;
}

class TaskStore {
  constructor(database, collectionName = "openaiq_image_tasks") {
    this.db = database;
    this.collectionName = collectionName;
    this.collection = database.collection(collectionName);
    this.command = database.command;
  }

  async ensureCollection() {
    try {
      await this.collection.limit(1).get();
      return;
    } catch (error) {
      const message = String(error && (error.message || error.errMsg) || "");
      if (!/collection.*(?:not exist|不存在)|DATABASE_COLLECTION_NOT_EXIST|-502005/i.test(message)) throw error;
    }
    try {
      await this.db.createCollection(this.collectionName);
    } catch (error) {
      const message = String(error && (error.message || error.errMsg) || "");
      if (!/already exists|已存在|DATABASE_COLLECTION_EXIST/i.test(message)) throw error;
    }
  }

  async create(task) {
    const { _id, ...data } = task;
    await this.collection.doc(_id).set(data);
    return task;
  }

  async get(taskId) {
    return firstDocument(await this.collection.doc(taskId).get());
  }

  async getOwned(taskId, owner) {
    const task = await this.get(taskId);
    return task && task.owner === owner ? task : null;
  }

  async listRecoverable(now, limit = 4) {
    const queued = await this.collection
      .where({ status: "queued" })
      .limit(limit)
      .get();
    const remaining = Math.max(0, limit - queued.data.length);
    if (!remaining) return queued.data;
    const abandoned = await this.collection
      .where({ status: "running" })
      .limit(Math.max(remaining, 20))
      .get();
    return queued.data.concat(abandoned.data.filter((task) => Number(task.leaseUntil) < now).slice(0, remaining));
  }

  async claim(taskId, leaseOwner, now, leaseMs) {
    let claimed = null;
    await this.db.runTransaction(async (transaction) => {
      const reference = transaction.collection(this.collectionName).doc(taskId);
      const task = firstDocument(await reference.get());
      if (!task) return;
      const recoverable = task.status === "queued" ||
        (task.status === "running" && Number(task.leaseUntil) < now);
      if (!recoverable) return;
      if (task.status === "running" && Number(task.attempts) >= 2) {
        await reference.update({
          status: "failed",
          error: "生图任务因容器中断未能完成，请重新提交。",
          statusCode: 503,
          encryptedPayload: null,
          updatedAt: now,
          completedAt: now,
          leaseOwner: "",
          leaseUntil: 0,
        });
        return;
      }
      if (Number(task.expiresAt) <= now) {
        await reference.update({
          status: "failed",
          error: "生图任务已过期，请重新提交。",
          statusCode: 408,
          encryptedPayload: null,
          updatedAt: now,
          completedAt: now,
          leaseOwner: "",
          leaseUntil: 0,
        });
        return;
      }
      const next = {
        status: "running",
        leaseOwner,
        leaseUntil: now + leaseMs,
        attempts: (Number(task.attempts) || 0) + 1,
        updatedAt: now,
        startedAt: Number(task.startedAt) || now,
      };
      await reference.update(next);
      claimed = { ...task, ...next };
    });
    return claimed;
  }

  async heartbeat(taskId, leaseOwner, now, leaseMs) {
    const result = await this.collection.where({
      _id: taskId,
      status: "running",
      leaseOwner,
    }).update({ leaseUntil: now + leaseMs, updatedAt: now });
    return updateCount(result) > 0;
  }

  async finishSuccess(taskId, leaseOwner, result, now) {
    const update = await this.collection.where({
      _id: taskId,
      status: "running",
      leaseOwner,
    }).update({
      status: "succeeded",
      result,
      error: "",
      statusCode: 0,
      encryptedPayload: null,
      leaseOwner: "",
      leaseUntil: 0,
      updatedAt: now,
      completedAt: now,
    });
    return updateCount(update) > 0;
  }

  async finishFailure(taskId, leaseOwner, error, now) {
    const update = await this.collection.where({
      _id: taskId,
      status: "running",
      leaseOwner,
    }).update({
      status: "failed",
      error: String(error.message || "生图任务失败").slice(0, 500),
      statusCode: Number(error.statusCode) || 0,
      encryptedPayload: null,
      leaseOwner: "",
      leaseUntil: 0,
      updatedAt: now,
      completedAt: now,
    });
    return updateCount(update) > 0;
  }

  async cancel(taskId, owner, now) {
    let canceled = false;
    let existing = null;
    await this.db.runTransaction(async (transaction) => {
      const reference = transaction.collection(this.collectionName).doc(taskId);
      const task = firstDocument(await reference.get());
      if (!task || task.owner !== owner) return;
      existing = task;
      if (["succeeded", "failed", "canceled"].includes(task.status)) return;
      await reference.update({
        status: "canceled",
        encryptedPayload: null,
        error: "",
        statusCode: 0,
        leaseOwner: "",
        leaseUntil: 0,
        updatedAt: now,
        completedAt: now,
      });
      canceled = true;
    });
    return { canceled, existing };
  }

  async purge(now, limit = 20) {
    const expired = await this.collection
      .where({ purgeAt: this.command.lt(now) })
      .limit(limit)
      .get();
    await Promise.all(expired.data.map((task) => this.collection.doc(task._id).remove()));
    return expired.data.length;
  }
}

function publicTask(task) {
  if (!task) return null;
  return {
    taskId: task._id,
    status: task.status,
    createdAt: Number(task.createdAt) || 0,
    startedAt: Number(task.startedAt) || 0,
    completedAt: Number(task.completedAt) || 0,
    result: task.status === "succeeded" ? task.result || null : null,
    error: task.status === "failed" ? String(task.error || "生图任务失败") : "",
    statusCode: task.status === "failed" ? Number(task.statusCode) || 0 : 0,
  };
}

module.exports = { TaskStore, publicTask };
