const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createWebRtcVad, UtteranceCollector, transcriptFromResponse, startPcmCapture, transcribeWav, FRAME_BYTES } = require("../miniprogram/utils/voice");

test("bundled WebRTC VAD accepts 16 kHz PCM frames", async () => {
  const bytes = fs.readFileSync(path.join(__dirname, "../miniprogram/vendor/fvad/fvad.wasm"));
  const vad = await createWebRtcVad((imports) => WebAssembly.instantiate(bytes, imports));
  try {
    assert.equal(vad.isSpeech(new Uint8Array(FRAME_BYTES)), false);
    assert.throws(() => vad.isSpeech(new Uint8Array(100)), /录音帧/);
  } finally { vad.destroy(); }
});

test("speech collects pre-roll and stops after 800 ms of silence", () => {
  const collector = new UtteranceCollector();
  const frame = new Uint8Array(FRAME_BYTES);
  for (let index = 0; index < 12; index += 1) assert.equal(collector.add(frame, false), "waiting");
  assert.equal(collector.add(frame, true), "waiting");
  assert.equal(collector.add(frame, true), "waiting");
  assert.equal(collector.add(frame, true), "started");
  for (let index = 0; index < 39; index += 1) assert.equal(collector.add(frame, false), "recording");
  assert.equal(collector.add(frame, false), "complete");
  const wav = new DataView(collector.toWav());
  assert.equal(String.fromCharCode(...new Uint8Array(wav.buffer, 0, 4)), "RIFF");
  assert.equal(wav.getUint32(24, true), 16000);
  assert.equal(wav.getUint16(22, true), 1);
  assert.equal(wav.getUint16(34, true), 16);
  assert.equal(wav.getUint32(40, true), 55 * FRAME_BYTES);
  assert.equal(wav.byteLength, 44 + 55 * FRAME_BYTES);
});

test("manual stop saves buffered audio before VAD starts", () => {
  const collector = new UtteranceCollector();
  const frame = new Uint8Array(FRAME_BYTES);
  frame[0] = 37;
  for (let index = 0; index < 6; index += 1) collector.add(frame, false);
  assert.equal(collector.completeManually(), true);
  const wav = new DataView(collector.toWav());
  assert.equal(wav.getUint32(40, true), 6 * FRAME_BYTES);
  assert.equal(wav.getUint8(44), 37);
});

test("ASR response handles full text, segments and service errors", () => {
  assert.equal(transcriptFromResponse({ full_text: " 你好 " }), "你好");
  assert.equal(transcriptFromResponse({ segments: [{ text: "你" }, { text: "好" }] }), "你\n好");
  assert.throws(() => transcriptFromResponse({ success: false, message: "限制" }), /限制/);
  assert.throws(() => transcriptFromResponse({ success: true }), /未返回文字/);
});

test("recorder listeners register once and canceled recordings cannot reach another turn", () => {
  const previousWx = global.wx;
  const listeners = { frame: [], stop: [], error: [] };
  const deleted = [];
  let started = 0, stopped = 0;
  const recorder = {
    onFrameRecorded(callback) { listeners.frame.push(callback); },
    onStop(callback) { listeners.stop.push(callback); },
    onError(callback) { listeners.error.push(callback); },
    start(options) { assert.equal(options.format, "PCM"); started += 1; },
    stop() { stopped += 1; },
  };
  global.wx = {
    getRecorderManager: () => recorder,
    getFileSystemManager: () => ({ unlink({ filePath }) { deleted.push(filePath); } }),
  };
  try {
    let firstFrames = 0, secondFrames = 0;
    const first = startPcmCapture({ onFrame() { firstFrames += 1; }, onStop() {}, onError() {} });
    listeners.frame[0]({ frameBuffer: new ArrayBuffer(640) });
    first.cancel();
    assert.equal(stopped, 1);
    assert.throws(() => startPcmCapture({ onFrame() {}, onStop() {}, onError() {} }), /仍在结束/);
    listeners.stop[0]({ tempFilePath: "canceled.pcm" });
    const second = startPcmCapture({ onFrame() { secondFrames += 1; }, onStop() {}, onError() {} });
    listeners.frame[0]({ frameBuffer: new ArrayBuffer(640) });
    second.stop();
    listeners.stop[0]({ tempFilePath: "complete.pcm" });
    assert.deepEqual([firstFrames, secondFrames, started, stopped], [1, 1, 2, 2]);
    assert.deepEqual(deleted, ["canceled.pcm"]);
    assert.deepEqual(Object.values(listeners).map((items) => items.length), [1, 1, 1]);
  } finally { global.wx = previousWx; }
});

test("ASR upload sends WAV and recognized text to the expected endpoint", async () => {
  const previousWx = global.wx;
  let request;
  global.wx = { uploadFile(options) {
    request = options;
    Promise.resolve().then(() => options.success({ statusCode: 200, data: JSON.stringify({ full_text: "识别的内容" }) }));
    return { abort() {} };
  } };
  try {
    assert.equal(await transcribeWav("utterance.wav").promise, "识别的内容");
    assert.equal(request.url, "https://tools.yeyupiaoling.cn/speech/api/asr");
    assert.equal(request.formData.language, "16k_zh");
    assert.equal(request.name, "file");
  } finally { global.wx = previousWx; }
});
