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

test("voice transcription UI and recording permission stay removed", () => {
  const root = path.resolve(__dirname, "..");
  const indexMarkup = fs.readFileSync(path.join(root, "miniprogram/pages/index/index.wxml"), "utf8");
  const settingsMarkup = fs.readFileSync(path.join(root, "miniprogram/pages/settings/settings.wxml"), "utf8");
  const appConfig = JSON.parse(fs.readFileSync(path.join(root, "miniprogram/app.json"), "utf8"));
  assert.doesNotMatch(indexMarkup, /toggleRecording|microphone|语音输入/);
  assert.doesNotMatch(settingsMarkup, /transcriptionModel|语音识别模型/);
  assert.equal(appConfig.permission && appConfig.permission["scope.record"], undefined);
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
  assert.match(markup, /class="page" style="{{pageHeightStyle}}"/);
  assert.doesNotMatch(markup, /height:\s*{{pageHeight}}px/);
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
