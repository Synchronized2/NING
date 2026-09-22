const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createEdgeSynthesizer, buildSsml } = require("../cloudfunctions/openaiProxy/edge-tts");

test("Edge style presets use supported prosody and never send unsupported express-as markup", () => {
  const ssml = buildSsml("你好 <世界>", "zh-CN-XiaoxiaoNeural", { style: "chat", rate: 10, pitch: 3 });
  assert.match(ssml, /pitch="\+5Hz" rate="\+15%"/);
  assert.match(ssml, /你好 &lt;世界&gt;/);
  assert.doesNotMatch(ssml, /express-as/);
  assert.throws(() => buildSsml("你好", "voice", { style: "<invalid>" }), /不支持的语音风格/);
});

function audioFrame(audio, headers = "Path:audio\r\nContent-Type:audio/mpeg\r\n") {
  const header = Buffer.from(headers);
  const size = Buffer.alloc(2);
  size.writeUInt16BE(header.length);
  return Buffer.concat([size, header, Buffer.from(audio)]);
}

function harness(options = {}) {
  let socket;
  let timeout;
  let timerCleared = false;
  class Socket extends EventEmitter {
    constructor(url, settings) {
      super();
      this.url = url;
      this.settings = settings;
      this.sent = [];
      socket = this;
    }
    send(data, callback) { this.sent.push(data); callback(); }
    close() { this.closed = true; this.emit("close"); }
    terminate() { this.terminated = true; this.emit("close"); }
  }
  const synthesize = createEdgeSynthesizer({
    WebSocket: Socket,
    setTimer(callback) { timeout = callback; return 1; },
    clearTimer() { timerCleared = true; },
    ...options,
  });
  const promise = synthesize("你好 <世界> & 再见", "zh-CN-XiaoxiaoNeural", { rate: 15, volume: -5, pitch: 10 });
  return { socket, promise, fireTimeout: () => timeout(), timerCleared: () => timerCleared };
}

test("Edge frames use declared header length, preserve audio bytes, and require turn.end", async () => {
  const h = harness();
  h.socket.emit("open");
  assert.match(h.socket.url, /Sec-MS-GEC=[A-F0-9]{64}/);
  assert.match(h.socket.sent[1], /你好 &lt;世界&gt; &amp; 再见/);
  assert.match(h.socket.sent[1], /pitch="\+10Hz" rate="\+15%" volume="-5%"/);
  const first = Buffer.from([0xff, 0xfb, 0, 13, 10]);
  const second = Buffer.from("Path:audio\r\n is part of the audio payload");
  h.socket.emit("message", audioFrame(first), true);
  h.socket.emit("message", audioFrame(second, "Content-Type:audio/mpeg\r\nPath:audio\r\nX-Extra:value\r\n"), true);
  let completed = false;
  h.promise.then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false);
  h.socket.emit("message", Buffer.from("Path:turn.end\r\n\r\n"), false);
  assert.deepEqual(await h.promise, Buffer.concat([first, second]));
  assert.equal(h.socket.closed, true);
  assert.equal(h.timerCleared(), true);
});

test("Edge socket close rejects partial audio instead of returning a truncated MP3", async () => {
  const h = harness();
  h.socket.emit("message", audioFrame("partial audio"), true);
  h.socket.emit("close");
  await assert.rejects(h.promise, /提前关闭/);
  assert.equal(h.socket.terminated, true);
});

test("Edge timeout rejects partial audio and terminates the connection", async () => {
  const h = harness();
  h.socket.emit("message", audioFrame("partial audio"), true);
  h.fireTimeout();
  await assert.rejects(h.promise, /超时/);
  assert.equal(h.socket.terminated, true);
  assert.equal(h.timerCleared(), true);
});

test("Edge rejects malformed binary header lengths", async () => {
  for (const frame of [Buffer.from([1]), Buffer.from([0, 20, 65]), Buffer.from([0, 0])]) {
    const h = harness();
    h.socket.emit("message", frame, true);
    await assert.rejects(h.promise, /头部长度/);
  }
});

test("Edge enforces cumulative audio limit before collecting the oversized chunk", async () => {
  const h = harness({ maxAudioBytes: 5 });
  h.socket.emit("message", audioFrame("123"), true);
  h.socket.emit("message", audioFrame("456"), true);
  await assert.rejects(h.promise, /大小限制/);
  assert.equal(h.socket.terminated, true);
});

test("only a turn.end header completes synthesis; body text and metadata cannot", async () => {
  const h = harness();
  h.socket.emit("message", audioFrame("ignored", "Path:audio.metadata\r\n"), true);
  h.socket.emit("message", Buffer.from('Path:audio.metadata\r\n\r\n{"text":"Path:turn.end"}'), false);
  h.socket.emit("message", audioFrame("mp3"), true);
  h.socket.emit("message", Buffer.from("Path:turn.end\r\n\r\n"), false);
  assert.equal((await h.promise).toString(), "mp3");
});

test("turn.end without any audio fails", async () => {
  const h = harness();
  h.socket.emit("message", Buffer.from("Path:turn.end\r\n\r\n"), false);
  await assert.rejects(h.promise, /没有返回音频/);
});

test("a send failure terminates synthesis and rejects", async () => {
  const h = harness();
  h.socket.send = (_data, callback) => callback(new Error("socket write failed"));
  h.socket.emit("open");
  await assert.rejects(h.promise, /发送失败/);
  assert.equal(h.socket.terminated, true);
});
