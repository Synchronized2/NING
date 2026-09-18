const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

function loadStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  global.wx = {
    getStorageSync(key) { return values.has(key) ? values.get(key) : ""; },
    setStorageSync(key, value) { values.set(key, value); },
    removeStorageSync(key) { values.delete(key); },
  };
  const file = path.resolve(__dirname, "../miniprogram/utils/storage.js");
  delete require.cache[file];
  return { storage: require(file), values };
}

test("migrates the 2.0 single service settings into a default profile", () => {
  const { storage } = loadStorage({
    "openaiq.settings.v1": {
      baseUrl: "https://example.com/v1",
      apiKey: "secret",
      chatModel: "gpt-test",
    },
  });
  const settings = storage.getSettings();
  assert.equal(settings.profileId, "default");
  assert.equal(settings.profileName, "默认服务");
  assert.equal(settings.chatModel, "gpt-test");
  assert.equal(settings.ttsVoice, "zh-CN-XiaoxiaoNeural");
  delete global.wx;
});

test("creates, lists and switches independent conversations", () => {
  const { storage } = loadStorage();
  const first = storage.createConversation();
  storage.saveConversation([{ id: "u1", role: "user", content: "第一段对话" }]);
  const second = storage.createConversation("第二段");
  storage.saveConversation([{ id: "u2", role: "user", content: "另一条消息" }]);
  assert.equal(storage.getConversationList().length, 2);
  assert.equal(storage.getActiveConversationId(), second.id);
  storage.selectConversation(first.id);
  assert.equal(storage.getConversation()[0].content, "第一段对话");
  delete global.wx;
});

test("records tokens, images and estimated cost locally", () => {
  const { storage } = loadStorage();
  storage.recordUsage({ promptTokens: 20, completionTokens: 30, totalTokens: 50, estimatedCost: 0.01 });
  storage.recordUsage({ imageCount: 1, estimatedCost: 0.02 });
  assert.deepEqual(storage.getUsageStats(), {
    requests: 2,
    promptTokens: 20,
    completionTokens: 30,
    totalTokens: 50,
    imageCount: 1,
    estimatedCost: 0.03,
  });
  delete global.wx;
});
