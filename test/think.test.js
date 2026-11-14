// Tests for the <think> stripper (src/think.ts) and the Groq max-tokens guard.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ThinkFilter } = require("../dist/think.js");
const { groqMaxTokens } = require("../dist/providers.js");

// Feed chunks one by one, the way a stream delivers them, and join the output.
function run(chunks) {
  const f = new ThinkFilter();
  return chunks.map((c) => f.push(c)).join("") + f.flush();
}

test("plain answers pass through unchanged", () => {
  assert.equal(run(["**Say:** hi", " there"]), "**Say:** hi there");
});

test("a think block is removed, with the blank lines after it", () => {
  assert.equal(run(["<think>secret plan</think>\n\n**Say:** hello"]), "**Say:** hello");
});

test("tags split across chunks are still caught", () => {
  assert.equal(run(["<th", "ink>reason", "ing</thi", "nk>", "\n**Say:** ok"]), "**Say:** ok");
});

test("a lone < that isn't a tag is kept", () => {
  assert.equal(run(["if a <", " b then"]), "if a < b then");
  assert.equal(run(["ends with <"]), "ends with <");
});

test("an unclosed think block shows nothing", () => {
  assert.equal(run(["<think>still thinking when cut off"]), "");
});

test("code with angle brackets is untouched", () => {
  const code = "```cpp\nvector<int> v;\nif (x<y) {}\n```";
  assert.equal(run([code.slice(0, 10), code.slice(10)]), code);
});

test("max tokens setting is cleaned up", () => {
  assert.equal(groqMaxTokens(800), 800);
  assert.equal(groqMaxTokens("1200"), 1200);
  assert.equal(groqMaxTokens(""), 1000);
  assert.equal(groqMaxTokens(-5), 1000);
  assert.equal(groqMaxTokens(99999), 16384);
});
