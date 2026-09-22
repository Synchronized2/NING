const crypto = require("node:crypto");

const EDGE_TTS_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const EDGE_VOICES_URL = `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=${EDGE_TTS_TOKEN}`;
const EDGE_TTS_URL = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const EDGE_CHROMIUM_VERSION = "143.0.3650.75";
const EDGE_GEC_VERSION = "1-143.0.3650";
const EDGE_STYLES = new Set(["general", "assistant", "chat", "customerservice", "newscast", "affectionate", "calm", "cheerful", "gentle", "lyrical", "serious"]);
const STYLE_PROSODY = {
  general: [0, 0, 0], assistant: [-5, 5, 0], chat: [5, 2, 0],
  customerservice: [-8, 3, 0], newscast: [0, -5, 5], affectionate: [-10, 6, 0],
  calm: [-15, -2, 0], cheerful: [10, 8, 0], gentle: [-10, 2, 0],
  lyrical: [-12, 4, 0], serious: [-8, -6, 0],
};

function escapeSsml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function signed(value, min, max, unit) {
  const number = Math.max(min, Math.min(max, Number(value) || 0));
  return `${number >= 0 ? "+" : ""}${number}${unit}`;
}

function buildSsml(text, voice, options = {}) {
  const style = String(options.style || "general");
  if (!EDGE_STYLES.has(style)) throw new Error("不支持的语音风格");
  const [rate, pitch, volume] = STYLE_PROSODY[style];
  const prosody = `<prosody pitch="${signed((Number(options.pitch) || 0) + pitch, -100, 100, "Hz")}" rate="${signed((Number(options.rate) || 0) + rate, -100, 200, "%")}" volume="${signed((Number(options.volume) || 0) + volume, -100, 100, "%")}">${escapeSsml(text)}</prosody>`;
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN"><voice name="${escapeSsml(voice)}">${prosody}</voice></speak>`;
}

function edgeGec() {
  const seconds = Math.floor(Date.now() / 1000) + 11644473600;
  const ticks = (seconds - seconds % 300) * 10000000;
  return crypto.createHash("sha256").update(`${ticks}${EDGE_TTS_TOKEN}`).digest("hex").toUpperCase();
}

function parseHeaders(value) {
  const headers = {};
  for (const line of value.split("\r\n")) {
    const separator = line.indexOf(":");
    if (separator > 0) headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }
  return headers;
}

function parseBinaryFrame(data) {
  const buffer = Buffer.from(data);
  if (buffer.length < 2) throw new Error("Edge TTS 音频帧缺少头部长度。");
  const headerLength = buffer.readUInt16BE(0);
  if (!headerLength || headerLength > buffer.length - 2) throw new Error("Edge TTS 音频帧头部长度无效。");
  return {
    headers: parseHeaders(buffer.subarray(2, headerLength + 2).toString("utf8")),
    audio: buffer.subarray(headerLength + 2),
  };
}

// Dependencies and limits are supplied by server code, never by the client event.
function createEdgeSynthesizer({ WebSocket, setTimer = setTimeout, clearTimer = clearTimeout,
  maxAudioBytes = 10 * 1024 * 1024, timeoutMs = 60000 }) {
  return function synthesizeEdge(text, voice, options = {}) {
    const requestId = crypto.randomBytes(16).toString("hex");
    const connectionId = crypto.randomBytes(16).toString("hex");
    const url = `${EDGE_TTS_URL}?TrustedClientToken=${EDGE_TTS_TOKEN}&Sec-MS-GEC=${edgeGec()}&Sec-MS-GEC-Version=${EDGE_GEC_VERSION}&ConnectionId=${connectionId}`;
    return new Promise((resolve, reject) => {
      const chunks = [];
      let totalBytes = 0;
      let settled = false;
      const socket = new WebSocket(url, {
        headers: {
          "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${EDGE_CHROMIUM_VERSION} Safari/537.36 Edg/${EDGE_CHROMIUM_VERSION}`,
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
          Cookie: `MUID=${crypto.randomBytes(16).toString("hex").toUpperCase()}`,
        },
        handshakeTimeout: 15000,
        maxPayload: maxAudioBytes + 65537,
      });
      let timer;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimer(timer);
        try { if (error) socket.terminate(); else socket.close(); } catch (_) {}
        if (error) reject(error);
        else if (!totalBytes) reject(new Error("Edge TTS 没有返回音频。"));
        else resolve(Buffer.concat(chunks, totalBytes));
      };
      timer = setTimer(() => finish(new Error("Edge TTS 合成超时，请重试。")), timeoutMs);
      socket.on("open", () => {
        if (settled) return;
        try {
          const timestamp = new Date().toUTCString();
          const onSent = (error) => { if (error) finish(new Error(`Edge TTS 发送失败：${String(error.message || error).slice(0, 200)}`)); };
          socket.send(`X-Timestamp:${timestamp}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n${JSON.stringify({ context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: false, wordBoundaryEnabled: false }, outputFormat: "audio-24khz-48kbitrate-mono-mp3" } } } })}`, onSent);
          if (settled) return;
          const ssml = buildSsml(text, voice, options);
          socket.send(`X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${timestamp}\r\nPath:ssml\r\n\r\n${ssml}`, onSent);
        } catch (error) { finish(error); }
      });
      socket.on("message", (data, isBinary) => {
        if (settled) return;
        try {
          if (isBinary) {
            const frame = parseBinaryFrame(data);
            if (frame.headers.path !== "audio") return;
            if (totalBytes + frame.audio.length > maxAudioBytes) throw new Error("Edge TTS 音频超过大小限制。");
            if (frame.audio.length) {
              totalBytes += frame.audio.length;
              chunks.push(frame.audio);
            }
          } else {
            const headerBlock = Buffer.from(data).toString("utf8").split("\r\n\r\n", 1)[0];
            if (parseHeaders(headerBlock).path === "turn.end") finish();
          }
        } catch (error) { finish(error); }
      });
      socket.on("error", (error) => finish(new Error(`Edge TTS 连接失败：${String(error && error.message || "请稍后重试").slice(0, 200)}`)));
      socket.on("close", () => finish(new Error("Edge TTS 连接提前关闭，音频未合成完整，请重试。")));
    });
  };
}

const synthesizeEdge = (...args) => createEdgeSynthesizer({ WebSocket: require("ws") })(...args);

module.exports = { EDGE_VOICES_URL, createEdgeSynthesizer, parseBinaryFrame, synthesizeEdge, buildSsml };
