// Tests for the answer renderer (src/renderer/markdown.ts).
// Run with: npm test   (it builds first, then runs these with Node's built-in test runner)
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// markdown.ts compiles to a plain browser script with global functions, so we
// run it inside a fresh sandbox and pull the functions out of it.
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "dist", "renderer", "markdown.js"), "utf8"), sandbox);
const { renderMarkdown, renderInline } = sandbox;

test("bold and the Say line", () => {
  assert.equal(renderMarkdown("**Say:** hello"), "<p><strong>Say:</strong> hello</p>");
});

test("maths with spaced asterisks is not italicised", () => {
  assert.equal(renderInline("2 * 3 * 4"), "2 * 3 * 4");
});

test("asterisks inside a word are not italicised", () => {
  assert.equal(renderInline("a*b*c"), "a*b*c");
});

test("inline code is left untouched by other rules", () => {
  assert.equal(renderInline("`a*b*c`"), "<code>a*b*c</code>");
  assert.equal(renderInline("`**not bold**`"), "<code>**not bold**</code>");
});

test("real italics still work", () => {
  assert.equal(renderInline("this is *important* ok"), "this is <em>important</em> ok");
  assert.equal(renderInline("_(cut off)_"), "<em>(cut off)</em>");
});

test("bullets and numbered steps become lists", () => {
  assert.equal(renderMarkdown("- a\n- b"), "<ul><li>a</li><li>b</li></ul>");
  assert.equal(renderMarkdown("1. a\n2. b"), "<ol><li>a</li><li>b</li></ol>");
  assert.equal(renderMarkdown("- a\n1. b"), "<ul><li>a</li></ul><ol><li>b</li></ol>");
});

test("http links render; other schemes do not", () => {
  assert.equal(
    renderInline("[docs](https://example.com/x)"),
    '<a href="https://example.com/x" target="_blank" rel="noreferrer">docs</a>'
  );
  assert.equal(renderInline("[x](javascript:alert(1))"), "[x](javascript:alert(1))");
});

test("HTML in answers is escaped, never executed", () => {
  assert.equal(renderInline('<img src=x onerror="alert(1)">'), "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
});

test("code blocks, including one still streaming in", () => {
  assert.equal(renderMarkdown("```python\nx = 1 < 2\n```"), "<pre><code>x = 1 &lt; 2</code></pre>");
  assert.equal(renderMarkdown("```\nhalf"), "<pre><code>half</code></pre>");
});
