---
name: add-setting
description: Checklist for adding a new user setting (or changing an existing one) end-to-end in Yours Truely: store, settings window, preload, main process. Use whenever a feature needs a new option in Settings.
---

A setting touches several files and a missed step fails silently. Work through every item and say which ones don't apply.

1. **`src/store.ts`**
   - Add the field to `interface Settings` **and** a value to `DEFAULTS`. `getSettings`/`saveSettings` keep only keys in `Object.keys(DEFAULTS)`, so a missing default means the setting is dropped.
   - A read-only value computed in main (like `captureExclusionSupported`) goes in `PublicSettings` / `getPublicSettings()` instead.
   - An API key gets its own `*KeyEnc` field in `FileShape`, a `has*Key` flag in `PublicSettings`, and handling in `getKeys`/`saveSettings` (`undefined` = keep, `""` = delete). Never send the raw key to the renderer.
2. **`src/renderer/global.d.ts`**: mirror the field in the hand-copied `PublicSettings` (and any union type). Typecheck won't flag a mismatch.
3. **`static/settings.html`**: add the input with an `id` matching the setting name. No inline script or style (CSP).
4. **`src/renderer/settings.ts`**
   - Text, select and number inputs: add to `TEXT_FIELDS`. Values are strings, so convert numbers in `save()` (see `groqMaxTokens`).
   - Checkboxes: handle in both `load()` and `save()`.
   - Selects: call `ensureOption(...)` so a saved value not in the list isn't lost.
   - Keep the rule that blank values are removed from the patch.
5. **`src/preload.ts`**: usually nothing. A new IPC channel or event needs a function on `window.api` and an entry in `EVENTS`.
6. **`src/main.ts`**: if it must take effect without a restart, apply it in the `settings:save` handler **and** at startup (`createOverlay()` / `start()`). Hotkey settings are re-registered there already.
7. **Consumer**: `providers.ts` / `prompts.ts` / wherever it's used. Put pure logic in an Electron-free file and add a `test/*.test.js` that requires it from `dist/`.
8. **`README.md`**: document the setting in the relevant section.
9. Verify with `npm run typecheck && npm test`.
