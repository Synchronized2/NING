const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function harness() {
  const requests = [];
  let definition;
  const wx = { showToast() {} };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/settings/settings.js"), "utf8"), {
    wx,
    Page(value) { definition = value; },
    setTimeout,
    require(id) {
      if (id.endsWith("/openai")) return {
        classifyModels: (models = []) => ({
          all: models,
          chat: models.filter((item) => item.startsWith("chat")),
          image: models.filter((item) => item.startsWith("image")),
        }),
        isSecureBaseUrl: (value) => /^https:\/\//.test(value),
        normalizeBaseUrl: (value) => String(value || "").replace(/\/$/, ""),
        listModels(options) {
          requests.push(options);
          const image = options.baseUrl.includes("image");
          return {
            abort() {},
            promise: Promise.resolve(image
              ? { all: ["custom-art-model"], chat: ["custom-art-model"], image: [] }
              : { all: ["chat-main", "image-shared"], chat: ["chat-main"], image: ["image-shared"] }),
          };
        },
      };
      return {
        getUsageStats: () => ({ estimatedCost: 0 }),
      };
    },
  });
  const page = { ...definition, data: { ...definition.data }, setData(values) { Object.assign(this.data, values); } };
  return { page, requests };
}

test("separate service model requests use their own URL and API key", async () => {
  const { page, requests } = harness();
  Object.assign(page.data, {
    useSeparateServices: true,
    baseUrl: "https://chat.example.com/v1/",
    apiKey: "chat-key",
    imageBaseUrl: "https://image.example.com/v1/",
    imageApiKey: "image-key",
    useCloudProxy: false,
  });
  await page.fetchChatModels();
  await page.fetchImageModels();
  assert.deepEqual(requests.map((item) => ({
    baseUrl: item.baseUrl,
    apiKey: item.apiKey,
    useCloudProxy: item.useCloudProxy,
  })), [
    { baseUrl: "https://chat.example.com/v1", apiKey: "chat-key", useCloudProxy: false },
    { baseUrl: "https://image.example.com/v1", apiKey: "image-key", useCloudProxy: false },
  ]);
  assert.deepEqual(page.data.chatModels, ["chat-main"]);
  assert.deepEqual(page.data.imageModels, ["custom-art-model"]);
});

test("shared mode uses the chat service response for both model selectors", async () => {
  const { page } = harness();
  Object.assign(page.data, {
    useSeparateServices: false,
    baseUrl: "https://chat.example.com/v1",
    apiKey: "shared-key",
  });
  await page.fetchChatModels();
  assert.deepEqual(page.data.chatModels, ["chat-main"]);
  assert.deepEqual(page.data.imageModels, ["image-shared"]);
  assert.equal(page.data.chatModel, "chat-main");
  assert.equal(page.data.imageModel, "image-shared");
});
