# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

CI (`.github/workflows/build-windows.yml`) runs, in order: `npm ci` → `npm run typecheck` → `npm test` → `npm run dist`. Run `npm run typecheck && npm test` before calling a change done.

- Tests import the **compiled `dist/` output**, not `src/`. Always use `npm test` (it builds first); running `node --test` directly tests stale code.
- Tests are CommonJS `node:test` + `node:assert/strict`. `test/markdown.test.js` loads `dist/renderer/markdown.js` into a `vm` sandbox and reads its globals.
- `npm start` does a full build every time; there is no watch mode.

## Two TypeScript builds

- `tsconfig.json` compiles only `src/*.ts` (main process, CommonJS) to `dist/`. A file in a new subfolder of `src/` is **not** compiled.
- `tsconfig.renderer.json` compiles `src/renderer/*.ts` to `dist/renderer/`. There is no bundler: the HTML loads each file with a plain `<script>` tag. Renderer files must have **no `import`/`export`**. They share globals (`markdown.ts` defines `escapeHtml`/`renderMarkdown`/`renderInline`, used by `overlay.ts`). `global.d.ts` is ambient.
- Static HTML/CSS lives in `static/` and is copied by `scripts/copy-static.js`. Both pages have a strict CSP (`script-src 'self'; style-src 'self'`), so no inline scripts or styles.
- Keep OS or pure logic in Electron-free files (like `platform.ts`, `think.ts`) so it can be unit-tested.

## Gotchas

- `store.ts` only keeps keys present in `DEFAULTS`. A setting without a default is silently dropped. Use the `add-setting` skill for the full wiring checklist.
- `Provider`, `PublicSettings` and other unions are **hand-duplicated** in `src/renderer/global.d.ts`. Typecheck won't catch a mismatch, so update both.
- `settings.ts` `TEXT_FIELDS` values are strings. Convert numbers in `save()`. Blank values are removed from the patch so they don't overwrite stored ones.
- Anything that must apply immediately after Save goes in the `settings:save` handler in `main.ts`, **and** at startup in `createOverlay()`.

## Security rules (keep them)

- Windows use `contextIsolation: true, nodeIntegration: false, sandbox: true`. The renderer reaches main only through `window.api` in `preload.ts`. New events must be added to its `EVENTS` allowlist.
- Raw API keys never go to the renderer, only `has*Key` booleans. Keys are encrypted with `safeStorage`. In a key patch, `undefined` means unchanged and `""` means delete.
- `innerHTML` may only receive `renderMarkdown`/`escapeHtml` output. `markdown.ts` escapes everything first, then adds its own tags.

## Style

- 2-space indent, double quotes, semicolons, trailing commas. No linter or formatter, so match the surrounding code.
- Keep the plain-English comment style: a `/** ... */` block at the top of each file explaining the why, and explanatory comments aimed at non-experts. User-facing error messages are full, friendly sentences (see `friendlyError`).
- Update `README.md` when behaviour, settings or hotkeys change.

## Workflow

Always work on a feature branch (`feat/...`, `fix/...`) and open a PR; never commit directly to `main`.
