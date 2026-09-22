const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

// Pass a local Playwright installation path when it is not installed in NING.
const { chromium } = require(process.argv[2] || "playwright");
const root = path.resolve(__dirname, "..");
const { decompress } = require(path.join(root, "miniprogram/components/live2d-avatar/lz4"));
const output = path.join(root, "artifacts/live2d");
fs.mkdirSync(output, { recursive: true });

async function verify() {
  const browser = await chromium.launch({ headless: true, ...(process.argv[3] ? { executablePath: process.argv[3] } : {}) });
  const result = [];
  try {
    for (const [width, height] of [[375, 812], [320, 568], [430, 932], [1024, 768]]) {
      const page = await browser.newPage({ viewport: { width, height } });
      const failures = [];
      page.on("pageerror", (error) => failures.push(error.message));
      await page.setContent(`<!doctype html><html><head><style>
        *{box-sizing:border-box} body{margin:0;background:#f7f8fa;font:14px Arial,sans-serif}
        header{height:56px;display:flex;align-items:center;padding:0 16px;background:white;border-bottom:1px solid #e6e8eb}
        nav{height:46px;display:flex;align-items:center;justify-content:center;gap:100px;background:white}
        .stage{height:180px;position:relative;background:#edf4f1;overflow:hidden}
        canvas{display:block;width:100%;height:100%}.name{position:absolute;top:12px;left:14px;color:#252a2d}
        main{padding:18px;line-height:1.7} footer{position:fixed;bottom:0;left:0;right:0;padding:14px;background:white;border-top:1px solid #e1e4e7}
        .input{height:44px;padding:10px;border:1px solid #d5d9dd;border-radius:4px;color:#7b8188}
      </style></head><body><header><strong>NING</strong></header><nav><span>对话</span><span>生图</span></nav>
      <section class="stage"><canvas id="avatar"></canvas><span class="name">小弥 · 在线</span></section>
      <main><strong>NING</strong><p>你好，今天想聊些什么？</p></main><footer><div class="input">输入消息</div></footer></body></html>`);
      await page.evaluate(() => { window.module = { exports: {} }; });
      await page.addScriptTag({ path: path.join(root, "miniprogram/vendor/live2d/live2dcubismcore.min.js") });
      await page.evaluate(() => {
        window.core = window.module.exports.Live2DCubismCore;
        window.module = { exports: {} };
      });
      await page.evaluate(() => {
        window.require = () => ({ Live2DCubismCore: window.core });
      });
      await page.addScriptTag({ path: path.join(root, "miniprogram/components/live2d-avatar/renderer.js") });
      const assetRoot = path.join(root, "miniprogram/assets/live2d/hiyori");
      const inputs = {
        model: (() => {
          const packed = require(path.join(assetRoot, "model-data.js"));
          return Buffer.from(decompress(Buffer.from(packed.data, "base64"), packed.size)).toString("base64");
        })(),
        textures: ["texture_00-512.png", "texture_01-512.png"].map((file) => `data:image/png;base64,${fs.readFileSync(path.join(assetRoot, file)).toString("base64")}`),
      };
      const stats = await page.evaluate(async ({ model, textures }) => {
        const canvas = document.getElementById("avatar");
        canvas.width = canvas.clientWidth * 2;
        canvas.height = canvas.clientHeight * 2;
        canvas.createImage = () => new Image();
        const gl = canvas.getContext("webgl", { stencil: true, alpha: true, preserveDrawingBuffer: true });
        const bytes = Uint8Array.from(atob(model), (value) => value.charCodeAt(0));
        window.avatar = new window.module.exports.Live2DRenderer({ canvas, gl, modelBuffer: bytes.buffer, textureSources: textures, width: canvas.width, height: canvas.height });
        await window.avatar.initialize();
        const pixels = () => {
          const buffer = new Uint8Array(canvas.width * canvas.height * 4);
          gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, buffer);
          let visible = 0, xMin = canvas.width, xMax = 0, yMin = canvas.height, yMax = 0;
          for (let index = 0; index < buffer.length; index += 4) {
            if (buffer[index + 3] > 25) {
              visible += 1;
              const x = index / 4 % canvas.width, y = Math.floor(index / 4 / canvas.width);
              xMin = Math.min(xMin, x); xMax = Math.max(xMax, x);
              yMin = Math.min(yMin, y); yMax = Math.max(yMax, y);
            }
          }
          return { buffer, visible, bounds: { xMin, xMax, yMin, yMax } };
        };
        window.avatar.draw(window.avatar.startedAt + 1000);
        const portrait = pixels();
        window.avatar.setViewMode("full");
        window.avatar.draw(window.avatar.startedAt + 1100);
        const full = pixels();
        window.avatar.setSpeaking(true);
        window.avatar.setFocus(0.8, 0.5);
        for (let index = 0; index < 20; index += 1) window.avatar.draw(window.avatar.startedAt + 2000 + index * 33);
        const animated = pixels();
        let changed = 0;
        full.buffer.forEach((value, index) => { if (value !== animated.buffer[index]) changed += 1; });
        return {
          portrait: { visible: portrait.visible, coverage: portrait.visible / (canvas.width * canvas.height), bounds: portrait.bounds },
          full: { visible: full.visible, coverage: full.visible / (canvas.width * canvas.height), bounds: full.bounds },
          changed,
          glError: gl.getError(),
          drawables: window.avatar.model.drawables.count,
        };
      }, inputs);
      assert.equal(stats.glError, 0, "WebGL errors");
      assert.ok(stats.portrait.coverage > stats.full.coverage, `portrait view is not enlarged at ${width}px`);
      assert.ok(stats.full.coverage > 0.015, `blank character at ${width}px`);
      assert.ok(stats.changed > 500, `character is not animated at ${width}px`);
      assert.ok(stats.portrait.bounds.yMax < 359, `head clipped in portrait view at ${width}px`);
      assert.ok(stats.portrait.bounds.xMin > 0 && stats.portrait.bounds.xMax < width * 2 - 1, `portrait clipped horizontally at ${width}px`);
      assert.ok(stats.full.bounds.yMin > 0 && stats.full.bounds.yMax < 359, `head or feet clipped in full view at ${width}px`);
      assert.ok(stats.full.bounds.xMin > 0 && stats.full.bounds.xMax < width * 2 - 1, `full view clipped horizontally at ${width}px`);
      assert.deepEqual(failures, []);
      await page.screenshot({ path: path.join(output, `avatar-full-${width}.png`) });
      await page.evaluate(() => {
        window.avatar.setViewMode("portrait");
        window.avatar.draw(window.avatar.startedAt + 3000);
      });
      await page.screenshot({ path: path.join(output, `avatar-portrait-${width}.png`) });
      await page.evaluate(() => window.avatar.destroy());
      result.push({ width, height, ...stats });
      await page.close();
    }
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser.close();
  }
}

verify().catch((error) => { console.error(error); process.exitCode = 1; });
