const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness() {
  const requests = [];
  const downloads = [];
  const audios = [];
  const deleted = [];
  const unlinked = [];
  const errors = [];
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
        played: false, destroyed: false,
        play() { this.played = true; },
        stop() {},
        destroy() { this.destroyed = true; },
        onEnded(callback) { this.ended = callback; },
        onError(callback) { this.error = callback; },
      };
      audios.push(audio);
      return audio;
    },
    showToast: (options) => errors.push(options),
    showModal: (options) => errors.push(options),
  };
  const source = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/index/index.js"), "utf8");
  vm.runInNewContext(source, {
    wx,
    Page(value) { definition = value; },
    require(id) {
      if (id.endsWith("/openai")) return {
        synthesizeSpeech() {
          const operation = { ...deferred(), aborted: false, abort() { this.aborted = true; } };
          requests.push(operation);
          return operation;
        },
      };
      return {};
    },
    setTimeout, clearTimeout,
  });
  const page = { ...definition, data: { ...definition.data }, setData(values) { Object.assign(this.data, values); } };
  return { page, requests, downloads, audios, deleted, unlinked, errors };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("cloud speech plays a downloaded local file and releases both copies on completion", async () => {
  const h = harness();
  const pending = h.page.speakText("你好", {});
  h.requests[0].resolve({ fileId: "cloud://tts/hello.mp3" });
  await flush();
  assert.equal(h.downloads[0].options.fileID, "cloud://tts/hello.mp3");
  h.downloads[0].options.success({ tempFilePath: "wxfile://tmp/hello.mp3" });
  await pending;
  assert.equal(h.audios[0].src, "wxfile://tmp/hello.mp3");
  assert.equal(h.audios[0].obeyMuteSwitch, false);
  assert.equal(h.audios[0].played, true);
  h.audios[0].ended();
  assert.equal(h.page.data.speaking, false);
  assert.equal(h.audios[0].destroyed, true);
  assert.deepEqual(h.deleted, ["cloud://tts/hello.mp3"]);
  assert.deepEqual(h.unlinked, ["wxfile://tmp/hello.mp3"]);
});

test("stopping during download ignores late success and removes its temporary file", async () => {
  const h = harness();
  const pending = h.page.speakText("你好", {});
  h.requests[0].resolve({ fileId: "cloud://tts/cancel.mp3" });
  await flush();
  h.page.stopSpeech();
  assert.equal(h.downloads[0].aborted, true);
  h.downloads[0].options.success({ tempFilePath: "wxfile://tmp/cancel.mp3" });
  await pending;
  assert.equal(h.audios.length, 0);
  assert.deepEqual(h.unlinked, ["wxfile://tmp/cancel.mp3"]);
  assert.deepEqual(h.deleted, ["cloud://tts/cancel.mp3"]);
  assert.deepEqual(h.errors, []);
});

test("late synthesis result and stale audio callbacks cannot interrupt newer playback", async () => {
  const h = harness();
  const first = h.page.speakText("第一条", {});
  const second = h.page.speakText("第二条", {});
  assert.equal(h.requests[0].aborted, true);
  h.requests[1].resolve({ localPath: "wxfile://tmp/second.mp3" });
  await second;
  h.requests[0].resolve({ fileId: "cloud://tts/first.mp3" });
  await first;
  assert.equal(h.audios.length, 1);
  assert.equal(h.audios[0].destroyed, false);
  assert.equal(h.page.data.speaking, true);
  assert.deepEqual(h.deleted, ["cloud://tts/first.mp3"]);

  const third = h.page.speakText("第三条", {});
  h.requests[2].resolve({ localPath: "wxfile://tmp/third.mp3" });
  await third;
  h.audios[0].ended();
  h.audios[0].error();
  assert.equal(h.audios[1].destroyed, false);
  assert.equal(h.page.data.speaking, true);
  assert.deepEqual(h.errors, []);
  h.page.stopSpeech();
});

test("unloading during synthesis prevents late playback and state updates", async () => {
  const h = harness();
  const pending = h.page.speakText("即将离开", {});
  h.page.onUnload();
  h.page.setData = () => assert.fail("unloaded page must not update its data");
  h.requests[0].resolve({ localPath: "wxfile://tmp/unloaded.mp3" });
  await pending;
  await h.page.speakText("忽略", {});
  assert.equal(h.audios.length, 0);
  assert.deepEqual(h.unlinked, ["wxfile://tmp/unloaded.mp3"]);
  assert.deepEqual(h.errors, []);
});

test("a stale synthesis failure does not clear current playback or show an error", async () => {
  const h = harness();
  const first = h.page.speakText("第一条", {});
  const second = h.page.speakText("第二条", {});
  h.requests[1].resolve({ localPath: "wxfile://tmp/second.mp3" });
  await second;
  h.requests[0].reject(new Error("late network failure"));
  await first;
  assert.equal(h.page.data.speaking, true);
  assert.equal(h.audios[0].destroyed, false);
  assert.deepEqual(h.errors, []);
  h.page.stopSpeech();
});
