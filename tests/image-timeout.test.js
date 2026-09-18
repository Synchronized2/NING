const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");

test("cloud image generation stays within the cloud-function limit while direct mode keeps ten minutes", () => {
  const cloudbase = JSON.parse(fs.readFileSync(path.join(projectRoot, "cloudbaserc.json"), "utf8"));
  const proxy = cloudbase.functions.find((item) => item.name === "openaiProxy");
  assert.ok(proxy, "openaiProxy deployment config is missing");
  assert.equal(proxy.timeout, 60);

  const clientSource = fs.readFileSync(
    path.join(projectRoot, "miniprogram", "utils", "openai.js"),
    "utf8",
  );
  assert.match(clientSource, /function imageRequest[\s\S]*?timeout:\s*600000,/);
  assert.match(clientSource, /callCloudProxy\("image"/);
  assert.doesNotMatch(clientSource, /callContainer|IMAGE_CONTAINER_ENV_ID/);

  const proxySource = fs.readFileSync(
    path.join(projectRoot, "cloudfunctions", "openaiProxy", "index.js"),
    "utf8",
  );
  assert.match(proxySource, /handleImage[\s\S]*?timeout:\s*55000,/);

  const appConfig = JSON.parse(fs.readFileSync(path.join(projectRoot, "miniprogram", "app.json"), "utf8"));
  assert.equal(appConfig.networkTimeout.request, 600000);
});
