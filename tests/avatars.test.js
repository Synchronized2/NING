const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const generated = require("../miniprogram/utils/avatar-catalog");

function harness(corrupt = false) {
  const bytes = [Buffer.from("MOC3-test"), Buffer.from("texture-test")];
  const files = bytes.map((data, index) => ({
    cloudPath: `ning/avatars/v1/test/${index}`,
    size: data.length,
    sha1: crypto.createHash("sha1").update(data).digest("hex"),
  }));
  const catalog = [
    { id: "hiyori", name: "Hiyori", builtIn: true },
    { id: "test", name: "Test", version: "v1", model: files[0], textures: [files[1]] },
  ];
  const storage = new Map();
  const disk = new Map();
  const downloads = [];
  const wx = {
    env: { USER_DATA_PATH: "wxfile://user" },
    getStorageSync(key) { return storage.get(key); },
    setStorageSync(key, value) { storage.set(key, value); },
    cloud: {
      downloadFile(options) {
        downloads.push(options.fileID);
        const index = downloads.length - 1;
        const filePath = `wxfile://temp/${index}`;
        disk.set(filePath, corrupt && index === 1 ? Buffer.from("wrong") : bytes[index]);
        setImmediate(() => options.success({ tempFilePath: filePath }));
        return { abort() {} };
      },
      getTempFileURL(options) {
        options.success({ fileList: options.fileList.map((fileID) => ({ fileID, tempFileURL: "https://example.com/image.png" })) });
      },
    },
    getFileSystemManager() {
      return {
        getFileInfo({ filePath, success, fail }) {
          const data = disk.get(filePath);
          if (!data) return fail(new Error("not found"));
          success({ size: data.length, digest: crypto.createHash("sha1").update(data).digest("hex") });
        },
        saveFile({ tempFilePath, filePath, success }) {
          disk.set(filePath, disk.get(tempFilePath));
          disk.delete(tempFilePath);
          success({ savedFilePath: filePath });
        },
        unlink({ filePath, success, fail }) {
          const deleted = disk.delete(filePath);
          if (deleted) success(); else fail(new Error("not found"));
        },
      };
    },
  };
  const source = fs.readFileSync(path.resolve(__dirname, "../miniprogram/utils/avatars.js"), "utf8");
  const sandbox = {
    module: { exports: {} }, wx,
    require(id) { return id === "./avatar-catalog" ? catalog : "cloud://test.bucket/"; },
  };
  vm.runInNewContext(source, sandbox);
  return { avatars: sandbox.module.exports, storage, disk, downloads };
}

test("generated catalog includes all 50 Cubism 3 entries without bundling remote model bytes", () => {
  const miniprogram = path.resolve(__dirname, "../miniprogram");
  const app = JSON.parse(fs.readFileSync(path.join(miniprogram, "app.json"), "utf8"));
  assert.equal(generated.length, 50);
  assert.equal(generated[0].id, "hiyori");
  assert.equal(new Set(generated.map((item) => item.id)).size, 50);
  assert.ok(generated.slice(1).every((item) => item.model.sha1.length === 40 && item.textures.length));
  assert.ok(generated.every((item) => item.preview && item.preview.cloudPath.startsWith("ning/avatars/v1/")));
  assert.deepEqual(app.subPackages, [{ root: "packages/avatars", pages: ["pages/index"] }]);
  let previewBytes = 0;
  generated.forEach((item) => {
    assert.equal(item.localPreview, `/packages/avatars/previews/${item.id}.jpg`);
    const preview = fs.readFileSync(path.join(miniprogram, item.localPreview.slice(1)));
    assert.equal(preview.readUInt16BE(0), 0xffd8);
    previewBytes += preview.length;
  });
  assert.ok(previewBytes < 1024 * 1024, `previews use ${previewBytes} bytes`);
});

test("avatar page uses an enlarged preview and full-width rows", () => {
  const root = path.resolve(__dirname, "../miniprogram/packages/avatars/pages");
  const styles = fs.readFileSync(path.join(root, "index.wxss"), "utf8");
  const markup = fs.readFileSync(path.join(root, "index.wxml"), "utf8");
  assert.match(styles, /\.avatar-preview\s*\{[^}]*height:\s*400rpx;/s);
  assert.match(styles, /\.avatar-list\s*\{[^}]*width:\s*100%;/s);
  assert.match(styles, /\.avatar-row\s*\{[^}]*width:\s*100%;/s);
  assert.match(markup, /<view wx:for="\{\{visibleAvatars\}\}"[^>]*class="avatar-row/);
  assert.doesNotMatch(markup, /<button wx:for="\{\{visibleAvatars\}\}"/);
});

test("downloaded model is verified and can be selected from persistent local files", async () => {
  const h = harness();
  assert.equal(h.avatars.getSelectedId(), "hiyori");
  assert.equal(await h.avatars.getActiveModel(), null);
  const progress = [];
  await h.avatars.downloadAvatar("test", (value) => progress.push(value)).promise;
  assert.deepEqual(h.downloads, ["cloud://test.bucket/ning/avatars/v1/test/0", "cloud://test.bucket/ning/avatars/v1/test/1"]);
  assert.equal(progress.at(-1), 100);
  assert.equal(h.avatars.isInstalled(h.avatars.getAvatar("test")), true);
  h.avatars.setSelectedId("test");
  const model = await h.avatars.getActiveModel();
  assert.match(model.modelPath, /model\.moc3$/);
  assert.equal(model.texturePaths.length, 1);
  await h.avatars.downloadAvatar("test").promise;
  assert.equal(h.downloads.length, 2, "cached files must not be fetched again");
});

test("a corrupt texture rolls back the whole installation and keeps Hiyori active", async () => {
  const h = harness(true);
  await assert.rejects(h.avatars.downloadAvatar("test").promise, /校验失败/);
  assert.equal(h.avatars.isInstalled(h.avatars.getAvatar("test")), false);
  assert.equal(h.avatars.getSelectedId(), "hiyori");
  assert.equal([...h.disk.keys()].some((file) => file.includes("ning-avatar-test")), false);
});
