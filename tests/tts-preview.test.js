const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function harness() {
  const requests = [], downloads = [], audios = [], deleted = [], unlinked = [];
  let definition;
  const wx = {
    cloud: {
      downloadFile(options) {
        const task = { options, aborted: false, abort() { this.aborted = true; } };
        downloads.push(task);
        return task;
      },
      deleteFile({ fileList }) { deleted.push(...fileList); },
    },
    getFileSystemManager: () => ({ unlink: ({ filePath }) => unlinked.push(filePath) }),
    createInnerAudioContext() {
      const audio = {
        play() { this.played = true; }, stop() {}, destroy() { this.destroyed = true; },
        onPlay(fn) { this.started = fn; }, onEnded(fn) { this.ended = fn; }, onError(fn) { this.error = fn; },
      };
      audios.push(audio);
      return audio;
    },
  };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/settings/settings.js"), "utf8"), {
    wx, Page(value) { definition = value; }, setTimeout,
    require(id) {
      if (id.endsWith("/openai")) return {
        classifyModels: () => ({ all: [], chat: [], image: [] }),
        synthesizeSpeech(options) {
          let resolve, reject;
          const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
          const operation = { options, promise, resolve, reject, abort() { this.aborted = true; } };
          requests.push(operation);
          return operation;
        },
      };
      return {
        getUsageStats: () => ({ estimatedCost: 0 }),
        getSettings: () => ({ ttsVoices: [], ttsVoice: "zh-CN-XiaoxiaoNeural" }),
        getProfiles: () => [{ id: "second", name: "Second" }],
        selectProfile: () => true,
      };
    },
  });
  const page = { ...definition, data: { ...definition.data }, setData(values) { Object.assign(this.data, values); } };
  return { page, requests, downloads, audios, deleted, unlinked };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("preview uses unsaved voice and prosody without a model URL or API key and confirms real playback", async () => {
  const h = harness();
  Object.assign(h.page.data, { ttsVoice: "zh-CN-YunxiNeural", ttsStyle: "chat", ttsRate: 20, ttsVolume: -10, ttsPitch: 5 });
  const pending = h.page.previewTtsVoice();
  assert.equal(h.page.data.ttsPreviewState, "preparing");
  const options = h.requests[0].options;
  assert.equal(options.voice, "zh-CN-YunxiNeural");
  assert.equal(options.style, "chat");
  assert.equal(options.rate, 20);
  assert.equal(options.volume, -10);
  assert.equal(options.pitch, 5);
  assert.ok(options.text.includes("你好"));
  assert.equal(options.apiKey, undefined);
  assert.equal(options.baseUrl, undefined);
  h.requests[0].resolve({ fileId: "cloud://tts/preview.mp3" });
  await flush();
  h.downloads[0].options.success({ tempFilePath: "wxfile://preview.mp3" });
  await pending;
  assert.equal(h.page.data.ttsPreviewState, "preparing");
  assert.equal(h.audios[0].obeyMuteSwitch, false);
  assert.equal(h.audios[0].src, "wxfile://preview.mp3");
  h.audios[0].started();
  assert.equal(h.page.data.ttsPreviewState, "playing");
  h.audios[0].ended();
  assert.equal(h.page.data.ttsPreviewState, "idle");
  assert.match(h.page.data.ttsPreviewStatus, /试听完成/);
  assert.deepEqual(h.deleted, ["cloud://tts/preview.mp3"]);
  assert.deepEqual(h.unlinked, ["wxfile://preview.mp3"]);
  assert.equal(h.audios[0].destroyed, true);
});

test("popular Chinese voices follow the supplied order and style selection updates the page", () => {
  const h = harness();
  assert.deepEqual(Array.from(h.page.data.ttsVoices.slice(0, 3), (item) => item.shortName), [
    "zh-CN-XiaoxiaoNeural", "zh-CN-YunxiNeural", "zh-CN-YunyangNeural",
  ]);
  assert.match(h.page.data.ttsVoiceNames[0], /晓晓 Xiaoxiao \(女声·温柔\)/);
  h.page.selectTtsStyle({ detail: { value: "2" } });
  assert.equal(h.page.data.ttsStyle, "chat");
  h.page.selectTtsVoice({ detail: { value: "1" } });
  assert.equal(h.page.data.ttsVoice, "zh-CN-YunxiNeural");
  assert.equal(h.page.data.ttsStyle, "general");
});

test("stopping a pending download ignores late audio and cleans up both files", async () => {
  const h = harness();
  const pending = h.page.previewTtsVoice();
  h.requests[0].resolve({ fileId: "cloud://tts/cancel.mp3" });
  await flush();
  await h.page.previewTtsVoice();
  assert.equal(h.downloads[0].aborted, true);
  h.downloads[0].options.success({ tempFilePath: "wxfile://cancel.mp3" });
  await pending;
  assert.equal(h.audios.length, 0);
  assert.deepEqual(h.deleted, ["cloud://tts/cancel.mp3"]);
  assert.deepEqual(h.unlinked, ["wxfile://cancel.mp3"]);
});

test("changing voice, prosody, profile or leaving cancels playback and ignores old callbacks", async () => {
  for (const action of [
    (page) => page.selectTtsVoice({ detail: { value: 1 } }),
    (page) => page.onSliderChange({ currentTarget: { dataset: { field: "ttsRate" } }, detail: { value: 30 } }),
    (page) => { page.data.profiles = [{ id: "second" }]; page.selectProfile({ detail: { value: 0 } }); },
    (page) => page.onHide(),
    (page) => page.onUnload(),
  ]) {
    const h = harness();
    const pending = h.page.previewTtsVoice();
    h.requests[0].resolve({ localPath: "wxfile://preview.mp3" });
    await pending;
    action(h.page);
    assert.equal(h.audios[0].destroyed, true);
    h.page.setData = () => assert.fail("cancelled callbacks must not update state");
    h.audios[0].started();
    h.audios[0].ended();
    h.audios[0].error();
  }
});

test("unload suppresses late synthesis while a real failure leaves preview retryable", async () => {
  const h = harness();
  const pending = h.page.previewTtsVoice();
  h.page.onUnload();
  assert.equal(h.requests[0].aborted, true);
  h.page.setData = () => assert.fail("unloaded page must not update state");
  h.requests[0].resolve({ localPath: "wxfile://late.mp3" });
  await pending;
  assert.equal(h.audios.length, 0);
  assert.deepEqual(h.unlinked, ["wxfile://late.mp3"]);

  const failure = harness();
  const failed = failure.page.previewTtsVoice();
  failure.requests[0].reject(new Error("cloud.callFunction:fail -501000 FunctionName parameter could not be found"));
  await failed;
  assert.equal(failure.page.data.ttsPreviewState, "idle");
  assert.equal(failure.page.data.ttsPreviewError, true);
  assert.match(failure.page.data.ttsPreviewStatus, /尚未就绪/);
  assert.ok(failure.page.data.ttsPreviewStatus.length < 100);
  const retry = failure.page.previewTtsVoice();
  failure.requests[1].resolve({ localPath: "wxfile://retry.mp3" });
  await retry;
  assert.equal(failure.audios.length, 1);
  failure.page.stopTtsPreview();
});
