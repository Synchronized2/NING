const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");

test("Cubism Core and model work without DOM, atob, WebAssembly or eval", async () => {
  const sandbox = {
    module: { exports: {} }, exports: {}, console, setTimeout, clearTimeout,
    wx: {
      base64ToArrayBuffer(value) {
        const buffer = Buffer.from(value, "base64");
        return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
      },
    },
  };
  vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  vm.runInContext(fs.readFileSync(path.join(root, "miniprogram/vendor/live2d/live2dcubismcore.min.js"), "utf8"), sandbox);
  await new Promise((resolve) => setTimeout(resolve, 25));
  const core = sandbox.module.exports.Live2DCubismCore;
  assert.ok(core.Version.csmGetVersion() > 0);
  const modelData = require("../miniprogram/assets/live2d/hiyori/model-data");
  const moc = core.Moc.fromArrayBuffer(sandbox.wx.base64ToArrayBuffer(modelData));
  assert.ok(moc);
  const model = core.Model.fromMoc(moc);
  assert.ok(model.drawables.count > 10);
  const mouth = model.parameters.ids.indexOf("ParamMouthOpenY");
  assert.ok(mouth >= 0);
  const before = model.drawables.vertexPositions.map((vertices) => Array.from(vertices));
  model.parameters.values[mouth] = 0.9;
  model.update();
  assert.ok(model.drawables.vertexPositions.some((vertices, index) => vertices.some((value, vertex) => value !== before[index][vertex])));
  model.release();
  moc._release();
});

test("blink function closes and reopens eyes", () => {
  const { blinkValue } = require("../miniprogram/components/live2d-avatar/renderer");
  assert.equal(blinkValue(2), 1);
  assert.equal(blinkValue(4.1), 0);
  assert.equal(blinkValue(4.35), 1);
});

test("Hiyori pose hides alternative arms throughout idle, chat, speech and touch", async () => {
  const core = require("../miniprogram/vendor/live2d/live2dcubismcore.min.js").Live2DCubismCore;
  const { Live2DRenderer, initializePose, waitForRuntime } = require("../miniprogram/components/live2d-avatar/renderer");
  await waitForRuntime();
  const bytes = Buffer.from(require("../miniprogram/assets/live2d/hiyori/model-data"), "base64");
  const moc = core.Moc.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const model = core.Model.fromMoc(moc);
  try {
    initializePose(model);
    const armA = model.parts.ids.indexOf("PartArmA");
    const armB = model.parts.ids.indexOf("PartArmB");
    assert.ok(armA >= 0 && armB >= 0);
    const renderer = new Live2DRenderer({});
    renderer.model = model;
    renderer.parameterIndex = new Map(model.parameters.ids.map((id, index) => [id, index]));
    for (const state of ["idle", "thinking", "answering"]) {
      renderer.setState(state);
      renderer.setSpeaking(state === "answering");
      renderer.triggerGesture();
      for (let frame = 0; frame < 30; frame += 1) {
        renderer.updateParameters(renderer.startedAt + frame * 33);
        assert.equal(model.parts.opacities[armA], 1);
        assert.equal(model.parts.opacities[armB], 0);
        const hidden = Array.from(model.drawables.parentPartIndices)
          .map((parent, index) => ({ parent, index })).filter((item) => item.parent === armB);
        assert.ok(hidden.length > 0);
        hidden.forEach(({ index }) => assert.equal(model.drawables.opacities[index], 0));
      }
    }
  } finally {
    model.release();
    moc._release();
  }
});

test("Live2D runtime does not require JSON modules unsupported by Mini Program", () => {
  const source = fs.readFileSync(path.join(root, "miniprogram/components/live2d-avatar/renderer.js"), "utf8");
  assert.doesNotMatch(source, /require\([^)]*\.json["']\)/);
  assert.match(source, /POSE_GROUPS = \[\["PartArmA", "PartArmB"\]\]/);
});

test("full-body fitting keeps all visible geometry inside the stage", async () => {
  const core = require("../miniprogram/vendor/live2d/live2dcubismcore.min.js").Live2DCubismCore;
  const { fullBodyTransform, initializePose, waitForRuntime } = require("../miniprogram/components/live2d-avatar/renderer");
  await waitForRuntime();
  const bytes = Buffer.from(require("../miniprogram/assets/live2d/hiyori/model-data"), "base64");
  const moc = core.Moc.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const model = core.Model.fromMoc(moc);
  try {
    initializePose(model);
    model.update();
    const transform = fullBodyTransform(model, 750, 720);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    model.drawables.vertexPositions.forEach((vertices, index) => {
      if (model.drawables.opacities[index] <= 0.001) return;
      for (let vertex = 0; vertex < vertices.length; vertex += 2) {
        const x = vertices[vertex] * transform[0] + transform[2];
        const y = vertices[vertex + 1] * transform[1] + transform[3];
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    });
    assert.ok(minX >= -0.85 && maxX <= 0.85);
    assert.ok(minY >= -0.85 && maxY <= 0.85);
  } finally {
    model.release();
    moc._release();
  }
});

test("portrait view keeps the head visible and zooms beyond the full-body view", async () => {
  const core = require("../miniprogram/vendor/live2d/live2dcubismcore.min.js").Live2DCubismCore;
  const { fullBodyTransform, portraitTransform, initializePose, waitForRuntime } = require("../miniprogram/components/live2d-avatar/renderer");
  await waitForRuntime();
  const bytes = Buffer.from(require("../miniprogram/assets/live2d/hiyori/model-data"), "base64");
  const moc = core.Moc.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const model = core.Model.fromMoc(moc);
  try {
    initializePose(model);
    model.update();
    const full = fullBodyTransform(model, 750, 720);
    const portrait = portraitTransform(model, 750, 720);
    assert.ok(portrait[0] > full[0]);
    assert.ok(portrait[1] > full[1]);
    let top = -Infinity;
    model.drawables.vertexPositions.forEach((vertices, index) => {
      if (model.drawables.opacities[index] <= 0.001) return;
      for (let vertex = 1; vertex < vertices.length; vertex += 2) {
        top = Math.max(top, vertices[vertex] * portrait[1] + portrait[3]);
      }
    });
    assert.ok(top <= 0.85 && top >= 0.82);
  } finally {
    model.release();
    moc._release();
  }
});

test("packaged model loads without any file-system access and preserves source bytes", () => {
  const previousWx = global.wx;
  global.wx = {
    base64ToArrayBuffer(value) {
      const bytes = Buffer.from(value, "base64");
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
    getFileSystemManager() { throw new Error("Package model must not use file-system reads"); },
  };
  try {
    const { loadModelBuffer } = require("../miniprogram/components/live2d-avatar/model");
    const actual = Buffer.from(loadModelBuffer());
    const source = fs.readFileSync(path.join(root, "assets/live2d/hiyori_pro_t11.moc3"));
    assert.deepEqual(actual, source);
    assert.equal(actual.subarray(0, 4).toString(), "MOC3");
    const component = fs.readFileSync(path.join(root, "miniprogram/components/live2d-avatar/index.js"), "utf8");
    assert.doesNotMatch(component, /readFile|MODEL_PATHS/);
  } finally {
    global.wx = previousWx;
  }
});

test("Live2D component event handlers and cleanup hooks exist", () => {
  let definition;
  global.Component = (value) => { definition = value; };
  require("../miniprogram/components/live2d-avatar/index");
  delete global.Component;
  const markup = fs.readFileSync(path.join(root, "miniprogram/components/live2d-avatar/index.wxml"), "utf8");
  for (const match of markup.matchAll(/\b(?:bind|catch)[a-z:]*=["']([^"']+)["']/g)) {
    assert.equal(typeof definition.methods[match[1]], "function", match[1]);
  }
  assert.equal(typeof definition.lifetimes.detached, "function");
  assert.equal(typeof definition.pageLifetimes.hide, "function");
  assert.equal(definition.data.viewMode, "portrait");
  let canceled = false, destroyed = false;
  const context = {
    _frame: 1,
    _canvas: { cancelAnimationFrame(frame) { assert.equal(frame, 1); canceled = true; } },
    _renderer: { destroy() { destroyed = true; } },
    ...definition.methods,
  };
  context.dispose();
  assert.equal(canceled, true);
  assert.equal(destroyed, true);
  assert.equal(context._renderer, null);
});

test("interaction preference is included in settings collection", () => {
  let definition;
  global.Page = (value) => { definition = value; };
  require("../miniprogram/pages/settings/settings");
  delete global.Page;
  const data = { ...definition.data, apiKey: "", chatModel: "", imageModel: "", avatarEnabled: false };
  assert.equal(definition.collectSettings.call({ data }).avatarEnabled, false);
});

test("bundled Mini Program stays below the two MiB main-package limit", () => {
  const bytes = (directory) => fs.readdirSync(directory, { withFileTypes: true }).reduce((total, entry) => {
    const target = path.join(directory, entry.name);
    return total + (entry.isDirectory() ? bytes(target) : fs.statSync(target).size);
  }, 0);
  assert.ok(bytes(path.join(root, "miniprogram")) < 2 * 1024 * 1024);
});
