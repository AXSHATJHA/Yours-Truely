// Tests for the Windows-version gate behind "Hide this window from screen capture".
// Run with: npm test   (it builds first, then runs these with Node's built-in test runner)
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const { supportsCaptureExclusion } = require(path.join(__dirname, "..", "dist", "platform.js"));

test("Windows 10 2004 and newer can exclude a window from capture", () => {
  assert.equal(supportsCaptureExclusion("10.0.19041", "win32"), true); // 2004, the first with the flag
  assert.equal(supportsCaptureExclusion("10.0.22631", "win32"), true); // Windows 11
});

test("Older Windows versions are rejected", () => {
  assert.equal(supportsCaptureExclusion("10.0.18363", "win32"), false); // 1909
  assert.equal(supportsCaptureExclusion("6.1.7601", "win32"), false); // Windows 7
});

test("Other platforms have no equivalent here", () => {
  assert.equal(supportsCaptureExclusion("14.0", "darwin"), false);
  assert.equal(supportsCaptureExclusion("6.8", "linux"), false);
});

test("Unparseable versions are treated as unsupported", () => {
  assert.equal(supportsCaptureExclusion("", "win32"), false);
  assert.equal(supportsCaptureExclusion("10.0", "win32"), false);
});
