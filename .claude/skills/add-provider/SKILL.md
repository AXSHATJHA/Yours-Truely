---
name: add-provider
description: Steps for adding a new AI model provider (or a new model to an existing one) to Yours Truely's providers.ts and settings. Use when asked to support another API, hosted model, or local model server.
---

1. **Type**: extend `type Provider` in `src/store.ts` **and** its copy in `src/renderer/global.d.ts`.
2. **Settings and key**: add model / base URL / options with `DEFAULTS` in `store.ts`. An API key needs a `*KeyEnc` field in `FileShape`, a `has*Key` flag in `PublicSettings`, and handling in `getKeys`/`saveSettings`. Follow the `add-setting` skill for the full wiring.
3. **Streaming** (`src/providers.ts`)
   - OpenAI-format APIs: reuse `streamChat(client, input, model, extra, lengthHint)` and `buildOpenAIMessages`. `ThinkFilter` already strips `<think>` blocks, and `finish_reason` `length`/`content_filter` are handled.
   - Otherwise write a `streamX` function that keeps the same rules: only the last `MAX_HISTORY` turns, sent as text; only the newest screenshot, as base64 JPEG; text streamed to `onText` as it arrives.
   - Add a branch to `streamAnswer`'s dispatch.
4. **Errors**: extend `friendlyError` (and a `groqError`-style mapper for provider-specific status codes) with full, friendly sentences that say what to do.
5. **First run**: update the check in `start()` in `src/main.ts` that opens Settings when the chosen provider has no key.
6. **UI**: add the option to the provider dropdown in `static/settings.html`, handle it in `showProvider` in `settings.ts`, and add a key field with a Forget button if it needs one.
7. **Docs**: add a README section with setup steps, the default model, and its trade-offs (speed, image support, limits).
8. Verify with `npm run typecheck && npm test`. Pure helpers (like `groqMaxTokens`) get a unit test.

Before hardcoding a model id or beta header, confirm it's current. Don't assume an id from memory.
