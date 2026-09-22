const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function loadPage(relativePath) {
  let definition = null;
  global.Page = (value) => {
    definition = value;
  };
  const absolute = path.resolve(__dirname, "..", relativePath);
  delete require.cache[absolute];
  require(absolute);
  delete global.Page;
  return definition;
}

test("chat context keeps text turns and excludes direct image-mode prompts", () => {
  const page = loadPage("miniprogram/pages/index/index.js");
  const context = {
    data: {
      messages: [
        { role: "user", type: "text", sourceMode: "chat", content: "第一问" },
        { role: "assistant", type: "text", sourceMode: "chat", content: "第一答" },
        { role: "user", type: "text", sourceMode: "image", content: "画一张图" },
        { role: "assistant", type: "image", sourceMode: "image", prompt: "画一张图", imageUrl: "local.png" },
        { role: "user", type: "text", sourceMode: "chat", content: "再画一张" },
        { role: "assistant", type: "image", sourceMode: "chat", prompt: "第二张图", imageUrl: "local2.png" },
      ],
    },
  };
  assert.deepEqual(page.apiMessages.call(context), [
    { role: "user", content: "第一问" },
    { role: "assistant", content: "第一答" },
    { role: "user", content: "再画一张" },
    { role: "assistant", content: "已按要求生成图片：第二张图" },
  ]);
});

test("every WXML event handler exists on its page definition", () => {
  const pages = [
    ["miniprogram/pages/index/index.js", "miniprogram/pages/index/index.wxml"],
    ["miniprogram/pages/history/history.js", "miniprogram/pages/history/history.wxml"],
    ["miniprogram/pages/settings/settings.js", "miniprogram/pages/settings/settings.wxml"],
    ["miniprogram/packages/avatars/pages/index.js", "miniprogram/packages/avatars/pages/index.wxml"],
  ];
  pages.forEach(([jsPath, wxmlPath]) => {
    const page = loadPage(jsPath);
    const markup = fs.readFileSync(path.resolve(__dirname, "..", wxmlPath), "utf8");
    const handlers = Array.from(markup.matchAll(/\b(?:bind|catch)[a-z:]*=["']([^"']+)["']/g), (match) => match[1]);
    handlers.forEach((handler) => {
      assert.equal(typeof page[handler], "function", `${wxmlPath}: missing handler ${handler}`);
    });
  });
});

test("recording is limited to interactive chat and declares microphone permission", () => {
  const root = path.resolve(__dirname, "..");
  const indexMarkup = fs.readFileSync(path.join(root, "miniprogram/pages/index/index.wxml"), "utf8");
  const settingsMarkup = fs.readFileSync(path.join(root, "miniprogram/pages/settings/settings.wxml"), "utf8");
  const appConfig = JSON.parse(fs.readFileSync(path.join(root, "miniprogram/app.json"), "utf8"));
  assert.match(indexMarkup, /avatarEnabled && mode === 'chat' && !interactiveTextInput/);
  assert.match(indexMarkup, /bindtap="toggleVoiceCapture"/);
  assert.doesNotMatch(settingsMarkup, /transcriptionModel|语音识别模型/);
  assert.match(appConfig.permission["scope.record"].desc, /语音对话/);
});

test("settings supports shared and separate chat and image services", () => {
  const markup = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/settings/settings.wxml"), "utf8");
  const indexSource = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/index/index.js"), "utf8");
  assert.match(markup, /checked="{{useSeparateServices}}"[^>]*bindchange="toggleSeparateServices"/);
  assert.match(markup, /data-field="imageBaseUrl"/);
  assert.match(markup, /data-field="imageApiKey"/);
  assert.match(markup, /bindtap="fetchChatModels"/);
  assert.match(markup, /bindtap="fetchImageModels"/);
  assert.match(indexSource, /const imageService = getImageService\(settings\)/);
  assert.match(indexSource, /baseUrl: imageService\.baseUrl/);
  assert.match(indexSource, /apiKey: imageService\.apiKey/);
});

test("home action icons use the enlarged dimensions", () => {
  const styles = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/index/index.wxss"), "utf8");
  assert.match(styles, /\.topbar \.top-icon image\s*{[^}]*width:\s*45rpx;[^}]*height:\s*45rpx;/s);
  assert.match(styles, /\.composer-tool image\s*{[^}]*width:\s*42rpx;[^}]*height:\s*42rpx;/s);
  assert.match(styles, /\.send-button image\s*{[^}]*width:\s*42rpx;[^}]*height:\s*42rpx;/s);
});

test("settings save bar is opaque and its button content is centered", () => {
  const styles = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/settings/settings.wxss"), "utf8");
  assert.match(styles, /\.save-bar\s*{[^}]*z-index:\s*20;[^}]*background:\s*#ffffff;/s);
  assert.match(styles, /\.primary-button\s*{[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*justify-content:\s*center;/s);
  assert.match(styles, /\.primary-button::after\s*{[^}]*border:\s*0;/s);
});

test("home composer height is resynchronized after page visibility and viewport changes", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/index/index.js"), "utf8");
  const markup = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/index/index.wxml"), "utf8");
  assert.match(source, /onShow\(\)\s*{[\s\S]*?this\._keyboardHeight = 0;[\s\S]*?this\.refreshPageHeight\(\)/);
  assert.match(source, /onResize\(event\)\s*{/);
  assert.match(source, /onKeyboardHeightChange\(event\)\s*{[\s\S]*?this\.refreshPageHeight\(\)/);
  assert.match(markup, /class="page .*" style="{{pageHeightStyle}}"/);
  assert.doesNotMatch(markup, /height:\s*{{pageHeight}}px/);
});

test("streaming answers alternate bottom anchors so the same message keeps scrolling", () => {
  const page = loadPage("miniprogram/pages/index/index.js");
  const context = {
    data: { scrollTarget: "page-bottom", messages: [{ id: "answer", role: "assistant" }] },
    setData(update) { Object.assign(this.data, update); },
    _unloaded: false,
  };
  page.scrollToBottom.call(context, "answer");
  assert.equal(context.data.scrollTarget, "page-bottom-alt");
  page.scrollToBottom.call(context, "answer");
  assert.equal(context.data.scrollTarget, "page-bottom");
  page.onMessageRendered.call({ ...context, scrollToBottom: () => { context.rendered = true; } }, {
    currentTarget: { dataset: { id: "answer" } },
  });
  assert.equal(context.rendered, true);
  const markup = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/index/index.wxml"), "utf8");
  assert.match(markup, /id="page-bottom"/);
  assert.match(markup, /id="page-bottom-alt"/);
  assert.match(markup, /bindrendered="onMessageRendered"/);
  assert.match(markup, /bindload="onMessageRendered"/);
});

test("interactive chat keeps only the latest turn over the avatar stage", () => {
  const page = loadPage("miniprogram/pages/index/index.js");
  const messages = [
    { id: "u1", role: "user", sourceMode: "chat", content: "上一问" },
    { id: "a1", role: "assistant", sourceMode: "chat", content: "上一答" },
    { id: "image", role: "assistant", sourceMode: "image", content: "" },
    { id: "u2", role: "user", sourceMode: "chat", content: "这一问" },
    { id: "a2", role: "assistant", sourceMode: "chat", content: "这一答" },
  ];
  const turn = page.latestStageTurn.call({ latestStageMessage: page.latestStageMessage }, messages);
  assert.equal(turn.stageUserMessage.id, "u2");
  assert.equal(turn.stageMessage.id, "a2");
  assert.equal(turn.stageAnswerVisible, true);
  const pending = page.latestStageTurn.call({ latestStageMessage: page.latestStageMessage }, [
    ...messages.slice(0, -1),
    { id: "a2", role: "assistant", sourceMode: "chat", content: "", pending: true },
  ]);
  assert.equal(pending.stageAnswerVisible, false);

  const markup = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/index/index.wxml"), "utf8");
  assert.match(markup, /class="interactive-stage"[\s\S]*class="interactive-dialog"[\s\S]*class="voice-controls"/);
  assert.doesNotMatch(markup, /interactive-reply/);
  assert.match(markup, /wx:if="{{stageUserMessage && !stageAnswerVisible}}"[\s\S]*stageUserMessage\.content[\s\S]*wx:else class="dialog-scroll"/);
  assert.match(markup, /stageDisplayText/);
  assert.doesNotMatch(markup, /stageMessage\.content/);
});

test("interactive mode forces automatic speech while text mode keeps streaming updates", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/index/index.js"), "utf8");
  const markup = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/index/index.wxml"), "utf8");
  assert.match(source, /const interactiveSpeech = this\.data\.avatarEnabled\s*\? this\.startInteractiveSpeech\(settings\)/);
  assert.match(source, /queueInteractiveSpeech\(interactiveSpeech, delta\)/);
  assert.match(source, /this\.scheduleStreamUpdate\(assistantId, streamedText\)/);
  assert.match(markup, /autoSpeak \|\| \(avatarEnabled && mode === 'chat'\)/);
});

test("Codex-client-only 403 does not retry through another transport", async () => {
  const page = loadPage("miniprogram/pages/index/index.js");
  let calls = 0;
  const restricted = new Error("当前账号只允许 Codex 官方客户端调用");
  restricted.statusCode = 403;
  restricted.code = "CODEX_OFFICIAL_CLIENT_ONLY";
  const context = {
    performChatRequest() {
      calls += 1;
      return Promise.reject(restricted);
    },
  };
  await assert.rejects(
    page.performCompatibleChatRequest.call(context, { useCloudProxy: false }, [], () => {}, false),
    (error) => error === restricted,
  );
  assert.equal(calls, 1);
});

test("the active interface is independent from the legacy agent UI sample", () => {
  const root = path.resolve(__dirname, "../miniprogram");
  const indexConfig = fs.readFileSync(path.join(root, "pages/index/index.json"), "utf8");
  const indexMarkup = fs.readFileSync(path.join(root, "pages/index/index.wxml"), "utf8");
  assert.match(indexConfig, /\/components\/markdown-preview\/index/);
  assert.doesNotMatch(`${indexConfig}\n${indexMarkup}`, /components\/agent-ui/);
  assert.equal(fs.existsSync(path.join(root, "components/agent-ui")), false);
});

test("submitted interface consistently uses the NING brand", () => {
  const root = path.resolve(__dirname, "../miniprogram");
  const interfaceFiles = [path.join(root, "app.json")];
  const visit = (directory) => {
    fs.readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) return visit(target);
      if (/\.(?:json|wxml)$/.test(entry.name)) interfaceFiles.push(target);
    });
  };
  visit(path.join(root, "pages"));

  const interfaceSource = interfaceFiles.map((file) => fs.readFileSync(file, "utf8")).join("\n");
  const settingsSource = fs.readFileSync(path.join(root, "pages/settings/settings.js"), "utf8");
  const apiSource = fs.readFileSync(path.join(root, "utils/openai.js"), "utf8");

  assert.match(interfaceSource, /NING/);
  assert.doesNotMatch(interfaceSource, /ChatGPT|OpenAIQ|OpenAI\s+官方|GPT|openaiProxy|openaiq-image/i);
  assert.match(settingsSource, /欢迎使用 NING/);
  assert.doesNotMatch(settingsSource, /ChatGPT|OpenAIQ|OpenAI\s+官方/);
  assert.doesNotMatch(apiSource, /请[^"\n]*(?:openaiProxy|openaiq-image)/i);
});
