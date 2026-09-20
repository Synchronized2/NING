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
        synthesizeSpeech(options) {
          const operation = { ...deferred(), options, aborted: false, abort() { this.aborted = true; } };
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

test("interactive speech shows only the sentence currently being played", async () => {
  const h = harness();
  const session = h.page.startInteractiveSpeech({});
  h.page.queueInteractiveSpeech(session, "孙悟空是《西游记》中的重要人物之一");
  assert.equal(h.requests.length, 0);
  h.page.queueInteractiveSpeech(session, "。他有七十二变和筋斗云，总能化险为夷！后来一路护送唐僧西行取经，最终被封为斗战胜佛");
  h.page.finishInteractiveSpeech(session, "");
  assert.equal(h.requests.length, 3);
  assert.equal(h.page.data.stageDisplayText, "正在思考…");
  assert.equal(h.page.data.stageAnswerVisible, false);

  h.requests[2].resolve({ localPath: "wxfile://tmp/three.mp3" });
  h.requests[1].resolve({ localPath: "wxfile://tmp/two.mp3" });
  await flush();
  assert.equal(h.audios.length, 0, "later segments must wait for the first audio");
  h.requests[0].resolve({ localPath: "wxfile://tmp/one.mp3" });
  await flush();
  assert.equal(h.page.data.stageDisplayText, "孙悟空是《西游记》中的重要人物之一。");
  assert.equal(h.page.data.stageAnswerVisible, true);
  assert.equal(h.audios.length, 1, "prefetched audio waits for the current segment");
  h.audios[0].ended();
  await flush();
  assert.equal(h.audios[0].destroyed, true);
  assert.equal(h.page.data.stageDisplayText, "他有七十二变和筋斗云，总能化险为夷！");
  assert.equal(h.requests.length, 3);

  h.audios[1].ended();
  await flush();
  assert.equal(h.page.data.stageDisplayText, "后来一路护送唐僧西行取经，最终被封为斗战胜佛");
  h.audios[2].ended();
  await flush();
  assert.equal(h.page.data.speaking, false);
  assert.equal(h.page.data.stageDisplayText, "后来一路护送唐僧西行取经，最终被封为斗战胜佛");
});

test("short sentences accumulate to fifteen characters and the final tail is flushed", () => {
  const h = harness();
  const session = h.page.startInteractiveSpeech({});
  h.page.queueInteractiveSpeech(session, "好。今天阳光明媚。");
  assert.equal(h.requests.length, 0);
  h.page.queueInteractiveSpeech(session, "我们一起出门散步吧。收到。");
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].options.text, "好。今天阳光明媚。我们一起出门散步吧。");
  h.page.finishInteractiveSpeech(session, "");
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].options.text, "收到。");
  h.page.stopSpeech();
});

test("a long sentence stays whole even when commas appear beyond ninety characters", () => {
  const h = harness();
  const session = h.page.startInteractiveSpeech({});
  const sentence = `${"前".repeat(60)}，${"后".repeat(60)}。`;
  h.page.queueInteractiveSpeech(session, sentence.slice(0, 70));
  assert.equal(h.requests.length, 0);
  h.page.queueInteractiveSpeech(session, sentence.slice(70));
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].options.text, sentence);
  h.page.stopSpeech();
});

test("stopping pipelined speech releases playing and prefetched audio", async () => {
  const h = harness();
  const session = h.page.startInteractiveSpeech({});
  h.page.queueInteractiveSpeech(session, "第一句话已经足够长，可以直接合成朗读。第二句话同样超过十五个字，需要提前合成。第三句话也足够长，停止时应当中止。");
  h.requests[0].resolve({ localPath: "wxfile://tmp/one.mp3" });
  await flush();
  h.requests[1].resolve({ fileId: "cloud://tts/two.mp3" });
  await flush();
  h.downloads[0].options.success({ tempFilePath: "wxfile://tmp/two.mp3" });
  await flush();
  assert.equal(h.audios.length, 1);
  h.page.stopSpeech();
  await flush();
  assert.equal(h.page.data.speaking, false);
  assert.equal(h.audios[0].destroyed, true);
  assert.deepEqual(h.unlinked, ["wxfile://tmp/one.mp3", "wxfile://tmp/two.mp3"]);
  assert.deepEqual(h.deleted, ["cloud://tts/two.mp3"]);
  assert.equal(h.requests.length, 3);
  assert.equal(h.requests[2].aborted, true);
  assert.deepEqual(h.errors, []);
});

test("a late prefetched result is discarded after speech is stopped", async () => {
  const h = harness();
  const session = h.page.startInteractiveSpeech({});
  h.page.queueInteractiveSpeech(session, "第一句话已经足够长，可以直接合成朗读。第二句话同样超过十五个字，需要提前合成。");
  h.requests[0].resolve({ localPath: "wxfile://tmp/one.mp3" });
  await flush();
  assert.equal(h.requests.length, 2);
  h.page.stopSpeech();
  assert.equal(h.requests[1].aborted, true);
  h.requests[1].resolve({ fileId: "cloud://tts/late.mp3" });
  await flush();
  assert.equal(h.audios.length, 1);
  assert.equal(h.audios[0].destroyed, true);
  assert.deepEqual(h.deleted, ["cloud://tts/late.mp3"]);
  assert.deepEqual(h.unlinked, ["wxfile://tmp/one.mp3"]);
  assert.deepEqual(h.errors, []);
});
