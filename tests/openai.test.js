const test = require("node:test");
const assert = require("node:assert/strict");

const {
  SseDecoder,
  ToolAccumulator,
  Utf8StreamDecoder,
  buildApiEndpoint,
  classifyModels,
  contentToText,
  createChatCompletion,
  createImage,
  isSecureBaseUrl,
  isCodexOnlyClientError,
  normalizeBaseUrl,
  parseImageToolCall,
  synthesizeSpeech,
} = require("../miniprogram/utils/openai");

async function withImmediateTimers(callback) {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  global.setTimeout = (handler) => {
    queueMicrotask(handler);
    return 1;
  };
  global.clearTimeout = () => {};
  try {
    return await callback();
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
}

test("normalizes full resource URLs and builds compatible endpoints", () => {
  assert.equal(normalizeBaseUrl(" https://example.com/v1/chat/completions/ "), "https://example.com/v1");
  assert.equal(buildApiEndpoint("https://example.com", "models"), "https://example.com/v1/models");
  assert.equal(buildApiEndpoint("https://example.com/v1", "models"), "https://example.com/v1/models");
  assert.equal(buildApiEndpoint("https://example.com/api/", "images/generations"), "https://example.com/api/images/generations");
});

test("accepts only HTTPS base URLs without query or fragment", () => {
  assert.equal(isSecureBaseUrl("https://api.example.com/v1"), true);
  assert.equal(isSecureBaseUrl("http://api.example.com/v1"), false);
  assert.equal(isSecureBaseUrl("https://api.example.com/v1?token=x"), false);
  assert.equal(isSecureBaseUrl("https://user:pass@api.example.com/v1"), false);
  assert.equal(isSecureBaseUrl("https://api.example.com:70000/v1"), false);
  assert.equal(isSecureBaseUrl("not-a-url"), false);
});

test("classifies and sorts common chat and image model IDs", () => {
  const models = classifyModels(["text-embedding-3", "gpt-image-1", "GPT-4o", "gpt-4o", "flux-pro", ""]);
  assert.deepEqual(models.all, ["flux-pro", "GPT-4o", "gpt-4o", "gpt-image-1", "text-embedding-3"]);
  assert.deepEqual(models.image, ["flux-pro", "gpt-image-1"]);
  assert.deepEqual(models.chat, ["GPT-4o", "gpt-4o"]);
});

test("decodes UTF-8 when a Chinese character is split across chunks", () => {
  const decoder = new Utf8StreamDecoder();
  const encoded = Buffer.from("你A", "utf8");
  assert.equal(decoder.push(encoded.subarray(0, 2)), "");
  assert.equal(decoder.push(encoded.subarray(2)), "你A");
  assert.equal(decoder.push(new Uint8Array(0), true), "");
});

test("parses SSE events split across arbitrary chunks", () => {
  const events = [];
  const decoder = new SseDecoder((data) => events.push(data));
  decoder.push("data: {\"choices\":[{\"delta\":");
  decoder.push("{\"content\":\"你好\"}}]}\n\n");
  decoder.push("data: [DONE]\n\n");
  assert.deepEqual(events, ['{"choices":[{"delta":{"content":"你好"}}]}', "[DONE]"]);
});

test("keeps a CRLF event boundary intact when split across chunks", () => {
  const events = [];
  const decoder = new SseDecoder((data) => events.push(data));
  decoder.push("data: one\r");
  decoder.push("\n\r");
  decoder.push("\n");
  assert.deepEqual(events, ["one"]);
});

test("accumulates streamed tool-call name and arguments", () => {
  const accumulator = new ToolAccumulator();
  accumulator.accept([{ index: 0, id: "call-1", function: { name: "generate_", arguments: '{"pro' } }]);
  accumulator.accept([{ index: 0, function: { name: "image", arguments: 'mpt":"山水"}' } }]);
  assert.deepEqual(accumulator.values(), [{ id: "call-1", name: "generate_image", arguments: '{"prompt":"山水"}' }]);
  assert.equal(parseImageToolCall(accumulator.values()[0]).prompt, "山水");
});

test("extracts text from multimodal content arrays", () => {
  assert.equal(contentToText([{ type: "text", text: "A" }, { type: "image_url" }, { type: "text", text: "B" }]), "AB");
});

test("streams chat deltas through the wx.request adapter", async () => {
  const chunks = [
    Buffer.from('data: {"choices":[{"delta":{"content":"你', "utf8"),
    Buffer.from('好"}}]}\n\ndata: [DONE]\n\n', "utf8"),
  ];
  global.wx = {
    request(options) {
      const task = {
        onChunkReceived(callback) {
          queueMicrotask(() => {
            chunks.forEach((chunk) => callback({ data: chunk }));
            options.success({ statusCode: 200, data: "" });
          });
        },
        abort() {},
      };
      return task;
    },
  };
  const deltas = [];
  const operation = createChatCompletion({
    baseUrl: "https://example.com/v1",
    apiKey: "secret",
    model: "chat-model",
    messages: [{ role: "user", content: "hi" }],
    onDelta: (delta) => deltas.push(delta),
    useCloudProxy: false,
  });
  const result = await operation.promise;
  assert.equal(result.text, "你好");
  assert.equal(deltas.join(""), "你好");
  delete global.wx;
});

test("accepts a non-streaming JSON chat response", async () => {
  global.wx = {
    request(options) {
      queueMicrotask(() => options.success({
        statusCode: 200,
        data: { choices: [{ message: { content: "普通响应" } }] },
      }));
      return { onChunkReceived() {}, abort() {} };
    },
  };
  const operation = createChatCompletion({
    baseUrl: "https://example.com/v1",
    apiKey: "secret",
    model: "chat-model",
    messages: [],
    useCloudProxy: false,
  });
  assert.equal((await operation.promise).text, "普通响应");
  delete global.wx;
});

test("translates a mixed Codex-client-only 403 response", async () => {
  global.wx = {
    request(options) {
      queueMicrotask(() => options.success({
        statusCode: 403,
        data: '{"error":{"message":"This account only allows Codex official clients"}}\ndata: {"error":"duplicate"}',
      }));
      return { onChunkReceived() {}, abort() {} };
    },
  };
  const operation = createChatCompletion({
    baseUrl: "https://example.com/v1",
    apiKey: "secret",
    model: "chat-model",
    messages: [{ role: "user", content: "hi" }],
    useCloudProxy: false,
  });
  await assert.rejects(operation.promise, (error) => {
    assert.equal(error.statusCode, 403);
    assert.equal(isCodexOnlyClientError(error), true);
    assert.match(error.message, /只允许 Codex 官方客户端/);
    assert.doesNotMatch(error.message, /duplicate|data:/);
    return true;
  });
  delete global.wx;
});

test("uses the deployed cloud proxy by default", async () => {
  let requestData = null;
  global.wx = {
    cloud: {
      callContainer() {
        assert.fail("normal chat must not call the image hosting service");
      },
      callFunction(options) {
        requestData = options.data;
        return Promise.resolve({
          result: {
            ok: true,
            data: { response: { choices: [{ message: { content: "云端响应" } }] } },
          },
        });
      },
    },
  };
  const operation = createChatCompletion({
    baseUrl: "https://example.com/v1",
    apiKey: "secret",
    model: "chat-model",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal((await operation.promise).text, "云端响应");
  assert.equal(requestData.action, "chat");
  assert.equal(requestData.apiKey, "secret");
  delete global.wx;
});

test("Edge TTS does not send model URL or API key", async () => {
  let requestData = null;
  global.wx = {
    cloud: {
      callFunction(options) {
        requestData = options.data;
        return Promise.resolve({ result: { ok: true, data: { fileId: "cloud://tts/test.mp3" } } });
      },
    },
  };
  const operation = synthesizeSpeech({ text: "你好", voice: "zh-CN-XiaoxiaoNeural" });
  assert.equal((await operation.promise).fileId, "cloud://tts/test.mp3");
  assert.deepEqual(Object.keys(requestData).sort(), ["action", "pitch", "rate", "style", "text", "voice", "volume"]);
  assert.equal(requestData.style, "general");
  assert.equal(requestData.action, "tts");
  delete global.wx;
});

test("Edge TTS automatically retries three transient cloud failures", async () => {
  let calls = 0;
  global.wx = {
    cloud: {
      callFunction() {
        calls += 1;
        if (calls <= 3) {
          return Promise.reject({
            errCode: -501000,
            errMsg: "cloud.callFunction:fail FunctionName parameter could not be found",
          });
        }
        return Promise.resolve({ result: { ok: true, data: { fileId: "cloud://tts/retried.mp3" } } });
      },
    },
  };
  const operation = synthesizeSpeech({ text: "重试朗读", voice: "zh-CN-XiaoxiaoNeural" });
  assert.equal((await operation.promise).fileId, "cloud://tts/retried.mp3");
  assert.equal(calls, 4);
  delete global.wx;
});

test("Edge TTS does not retry a non-transient validation failure", async () => {
  let calls = 0;
  global.wx = {
    cloud: {
      callFunction() {
        calls += 1;
        return Promise.resolve({ result: { ok: false, statusCode: 400, error: "音色参数无效" } });
      },
    },
  };
  const operation = synthesizeSpeech({ text: "无效参数", voice: "invalid" });
  await assert.rejects(operation.promise, /音色参数无效/);
  assert.equal(calls, 1);
  delete global.wx;
});

test("image generation drops unsupported style and quality parameters", async () => {
  const requests = [];
  global.wx = {
    cloud: {
      callContainer() {
        assert.fail("image generation must not call cloud hosting");
      },
      callFunction(options) {
        requests.push(options.data);
        if (requests.length === 1) {
          return Promise.resolve({ result: { ok: false, statusCode: 400, error: "HTTP 400: Unknown parameter: style" } });
        }
        if (requests.length === 2) {
          return Promise.resolve({ result: { ok: false, statusCode: 400, error: "HTTP 400: Unsupported parameter: quality" } });
        }
        return Promise.resolve({ result: { ok: true, data: { fileId: "cloud://image/generated.png" } } });
      },
    },
  };
  const operation = createImage({
    baseUrl: "https://example.com/v1",
    apiKey: "secret",
    model: "gpt-image-2",
    prompt: "云顶天宫",
    size: "1024x1024",
    quality: "standard",
    style: "vivid",
    useCloudProxy: true,
  });
  assert.equal((await operation.promise).fileId, "cloud://image/generated.png");
  assert.equal(requests.length, 3);
  assert.equal(requests[0].action, "image");
  assert.equal(requests[0].style, "vivid");
  assert.equal(requests[0].quality, "standard");
  assert.equal(requests[1].style, "");
  assert.equal(requests[1].quality, "standard");
  assert.equal(requests[2].style, "");
  assert.equal(requests[2].quality, "");
  assert.equal(requests[2].size, "1024x1024");
  delete global.wx;
});

test("image generation preserves unrelated 400 errors without retrying", async () => {
  let calls = 0;
  global.wx = {
    cloud: {
      callFunction() {
        calls += 1;
        return Promise.resolve({ result: { ok: false, statusCode: 400, error: "prompt is required" } });
      },
    },
  };
  const operation = createImage({
    baseUrl: "https://example.com/v1",
    apiKey: "secret",
    model: "gpt-image-2",
    prompt: "测试",
    quality: "standard",
    style: "vivid",
    useCloudProxy: true,
  });
  await assert.rejects(operation.promise, /prompt is required/);
  assert.equal(calls, 1);
  delete global.wx;
});

test("cloud image generation uses the same proxy as chat", async () => {
  const actions = [];
  global.wx = {
    cloud: {
      callFunction(options) {
        actions.push(options.data.action);
        if (options.data.action === "image") {
          return Promise.resolve({ result: { ok: true, data: { fileId: "cloud://image/proxy.png" } } });
        }
        return Promise.resolve({
          result: { ok: true, data: { response: { choices: [{ message: { content: "对话仍然正常" } }] } } },
        });
      },
      callContainer() {
        assert.fail("cloud hosting must not be used");
      },
    },
  };
  const operation = createImage({
    baseUrl: "https://example.com/v1",
    apiKey: "secret",
    model: "gpt-image-2",
    prompt: "测试",
    useCloudProxy: true,
  });
  assert.equal((await operation.promise).fileId, "cloud://image/proxy.png");
  const chat = createChatCompletion({
    baseUrl: "https://example.com/v1",
    apiKey: "secret",
    model: "chat-model",
    messages: [{ role: "user", content: "你好" }],
    useCloudProxy: true,
  });
  assert.equal((await chat.promise).text, "对话仍然正常");
  assert.deepEqual(actions, ["image", "chat"]);
  delete global.wx;
});

test("stopping cloud image generation rejects locally and cleans up a late image", async () => {
  let resolveInvocation;
  const deleted = [];
  global.wx = {
    cloud: {
      callFunction() {
        return new Promise((resolve) => { resolveInvocation = resolve; });
      },
      deleteFile(options) {
        deleted.push(...options.fileList);
        return Promise.resolve();
      },
    },
  };
  const operation = createImage({
    baseUrl: "https://example.com/v1",
    apiKey: "secret",
    model: "gpt-image-2",
    prompt: "测试取消",
    useCloudProxy: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  operation.abort();
  await assert.rejects(operation.promise, (error) => error.aborted === true);
  resolveInvocation({ result: { ok: true, data: { fileId: "cloud://image/late.png" } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(deleted, ["cloud://image/late.png"]);
  delete global.wx;
});

test("direct image mode remains available with a ten-minute request timeout", async () => {
  let requestOptions = null;
  global.wx = {
    request(options) {
      requestOptions = options;
      queueMicrotask(() => options.success({
        statusCode: 200,
        data: { data: [{ url: "https://images.example.com/generated.png" }] },
      }));
      return { abort() {} };
    },
  };
  const operation = createImage({
    baseUrl: "https://example.com/v1",
    apiKey: "secret",
    model: "gpt-image-2",
    prompt: "直连测试",
    useCloudProxy: false,
  });
  assert.equal((await operation.promise).url, "https://images.example.com/generated.png");
  assert.equal(requestOptions.timeout, 600000);
  assert.equal(requestOptions.url, "https://example.com/v1/images/generations");
  delete global.wx;
});
