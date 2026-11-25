/**
 * Claude Code PostToolUse hook: after Claude edits a .ts file, run both
 * TypeScript typechecks (main + renderer). On errors, exit 2 so the compiler
 * output is fed back to Claude to fix. Uses Node instead of jq so it works on
 * a plain Windows setup.
 */
const { execSync } = require("child_process");
const path = require("path");

let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  let file = "";
  try {
    const data = JSON.parse(input);
    file = (data.tool_input && data.tool_input.file_path) || (data.tool_response && data.tool_response.filePath) || "";
  } catch {
    process.exit(0); // not the payload we expected; never block on that
  }
  if (!/\.ts$/.test(file)) process.exit(0);

  const root = path.resolve(__dirname, "..", "..");
  try {
    execSync("npm run typecheck --silent", { cwd: root, stdio: "pipe", encoding: "utf8" });
  } catch (err) {
    const out = `${err.stdout || ""}${err.stderr || ""}`.trim();
    process.stderr.write(`npm run typecheck failed after editing ${path.basename(file)}:\n${out}\n`);
    process.exit(2);
  }
});
