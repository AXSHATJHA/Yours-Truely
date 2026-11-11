// Copies the HTML/CSS files (which TypeScript doesn't touch) into dist/renderer.
const fs = require("fs");
const path = require("path");
const src = path.join(__dirname, "..", "static");
const out = path.join(__dirname, "..", "dist", "renderer");
fs.mkdirSync(out, { recursive: true });
for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(out, f));
