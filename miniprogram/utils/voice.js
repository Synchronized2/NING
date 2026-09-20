const ASR_URL = "https://tools.yeyupiaoling.cn/speech/api/asr";
const SAMPLE_RATE = 16000;
const FRAME_BYTES = 640; // 20 ms of mono 16-bit PCM.

async function createWebRtcVad(instantiate) {
  const wasm = (typeof WXWebAssembly !== "undefined" ? WXWebAssembly : null);
  const factory = instantiate || (wasm && ((imports) => wasm.instantiate("/vendor/fvad/fvad.wasm", imports)));
  if (!factory) throw new Error("当前微信版本不支持 WebRTC VAD，请更新微信后重试");
  let memory;
  const result = await factory({ a: {
    a() { throw new Error("WebRTC VAD 初始化失败"); },
    b(size) {
      if (!memory) return 0;
      try {
        memory.grow(Math.ceil((size - memory.buffer.byteLength) / 65536));
        return 1;
      } catch (_) { return 0; }
    },
  } });
  const api = (result.instance || result).exports;
  memory = api.c;
  api.d();
  const handle = api.e();
  if (!handle || api.k(handle, SAMPLE_RATE) !== 0 || api.j(handle, 2) !== 0) {
    if (handle) api.h(handle);
    throw new Error("WebRTC VAD 不支持当前录音格式");
  }
  const framePointer = api.f(FRAME_BYTES);
  if (!framePointer) {
    api.h(handle);
    throw new Error("WebRTC VAD 内存不足");
  }
  return {
    isSpeech(frame) {
      if (frame.byteLength !== FRAME_BYTES) throw new Error("无效的录音帧");
      new Uint8Array(memory.buffer, framePointer, FRAME_BYTES).set(frame);
      const result = api.l(handle, framePointer, FRAME_BYTES / 2);
      if (result < 0) throw new Error("WebRTC VAD 录音帧处理失败");
      return result === 1;
    },
    destroy() { api.i(framePointer); api.h(handle); },
  };
}

class UtteranceCollector {
  constructor() {
    this.preRoll = [];
    this.frames = [];
    this.started = false;
    this.speechRun = 0;
    this.silenceRun = 0;
    this.waited = 0;
  }

  add(frame, speech) {
    if (frame.byteLength !== FRAME_BYTES) throw new Error("无效的录音帧");
    this.waited += 1;
    if (!this.started) {
      this.preRoll.push(frame.slice());
      if (this.preRoll.length > 15) this.preRoll.shift();
      this.speechRun = speech ? this.speechRun + 1 : 0;
      if (this.speechRun >= 3) {
        this.started = true;
        this.frames.push(...this.preRoll);
        this.preRoll = [];
        return "started";
      }
      return this.waited >= 750 ? "timeout" : "waiting";
    }
    this.frames.push(frame.slice());
    this.silenceRun = speech ? 0 : this.silenceRun + 1;
    if (this.silenceRun >= 40 || this.frames.length >= 1500) return "complete";
    return "recording";
  }

  toWav() {
    const byteLength = this.frames.length * FRAME_BYTES;
    const wav = new ArrayBuffer(44 + byteLength);
    const view = new DataView(wav);
    const label = (offset, text) => { for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index)); };
    label(0, "RIFF"); view.setUint32(4, 36 + byteLength, true); label(8, "WAVE");
    label(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, 1, true); view.setUint32(24, SAMPLE_RATE, true);
    view.setUint32(28, SAMPLE_RATE * 2, true); view.setUint16(32, 2, true);
    view.setUint16(34, 16, true); label(36, "data"); view.setUint32(40, byteLength, true);
    const output = new Uint8Array(wav, 44);
    this.frames.forEach((frame, index) => output.set(new Uint8Array(frame), index * FRAME_BYTES));
    return wav;
  }

  completeManually() {
    if (!this.started && this.preRoll.length) {
      this.frames.push(...this.preRoll);
      this.preRoll = [];
      this.started = true;
    }
    return this.frames.length > 0;
  }
}

function transcriptFromResponse(data) {
  if (!data || typeof data !== "object") throw new Error("语音识别返回了无效数据");
  if (data.success === false) throw new Error(String(data.message || data.error || "语音识别失败"));
  const text = data.full_text || data.text || (Array.isArray(data.segments)
    ? data.segments.map((item) => item && item.text || "").join("\n") : "");
  if (!String(text || "").trim()) throw new Error("语音识别未返回文字，请重试");
  return String(text).trim();
}

function transcribeWav(filePath) {
  let task;
  const promise = new Promise((resolve, reject) => {
    task = wx.uploadFile({
      url: ASR_URL,
      filePath,
      name: "file",
      formData: { language: "16k_zh" },
      timeout: 60000,
      success(response) {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`语音识别服务返回 HTTP ${response.statusCode}`));
          return;
        }
        try { resolve(transcriptFromResponse(JSON.parse(response.data))); }
        catch (error) { reject(error); }
      },
      fail(error) {
        const domain = /domain|合法域名|url not in domain list/i.test(error.errMsg || "");
        reject(new Error(domain ? "请在小程序后台配置 tools.yeyupiaoling.cn 为 uploadFile 合法域名" : error.errMsg || "语音上传失败"));
      },
    });
  });
  return { promise, abort() { if (task && task.abort) task.abort(); } };
}

let recorder;
let currentCapture;
let stopping = false;

function startPcmCapture(handlers) {
  if (currentCapture || stopping) throw new Error("上一段录音仍在结束，请稍后重试");
  if (!recorder) {
    recorder = wx.getRecorderManager();
    recorder.onFrameRecorded((event) => {
      if (currentCapture) currentCapture.onFrame(event);
    });
    recorder.onStop((result) => {
      const capture = currentCapture;
      currentCapture = null;
      stopping = false;
      if (capture) capture.onStop(result);
      else if (result.tempFilePath) wx.getFileSystemManager().unlink({ filePath: result.tempFilePath, fail() {} });
    });
    recorder.onError((error) => {
      const capture = currentCapture;
      currentCapture = null;
      stopping = false;
      if (capture) capture.onError(error);
    });
  }
  currentCapture = handlers;
  try {
    recorder.start({ duration: 50000, sampleRate: SAMPLE_RATE, numberOfChannels: 1, format: "PCM", frameSize: 4 });
  } catch (error) {
    currentCapture = null;
    throw error;
  }
  return {
    stop() {
      if (currentCapture !== handlers || stopping) return;
      stopping = true;
      recorder.stop();
    },
    cancel() {
      if (currentCapture !== handlers) return;
      currentCapture = null;
      if (!stopping) {
        stopping = true;
        recorder.stop();
      }
    },
  };
}

module.exports = { createWebRtcVad, UtteranceCollector, transcribeWav, transcriptFromResponse, startPcmCapture, FRAME_BYTES };
