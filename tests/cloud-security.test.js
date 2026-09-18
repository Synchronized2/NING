const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildEndpoint,
  isPrivateIp,
} = require("../cloudfunctions/openaiProxy/security");

test("cloud proxy builds only HTTPS compatible-model endpoints", () => {
  assert.equal(buildEndpoint("https://example.com", "models").href, "https://example.com/v1/models");
  assert.equal(buildEndpoint("https://example.com/api/v1/chat/completions", "models").href, "https://example.com/api/v1/models");
  assert.throws(() => buildEndpoint("http://example.com/v1", "models"), /HTTPS/);
  assert.throws(() => buildEndpoint("https://user:pass@example.com/v1", "models"), /不含凭据/);
  assert.throws(() => buildEndpoint("https://example.com/v1?key=x", "models"), /查询参数/);
});

test("cloud proxy blocks private, metadata, loopback and documentation IPs", () => {
  [
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "198.18.0.1",
    "203.0.113.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
  ].forEach((address) => assert.equal(isPrivateIp(address), true, address));
  assert.equal(isPrivateIp("1.1.1.1"), false);
  assert.equal(isPrivateIp("2606:4700:4700::1111"), false);
});
