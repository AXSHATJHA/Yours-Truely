// The small always-on-top answer window.
// renderMarkdown() and escapeHtml() come from markdown.ts, loaded just before this file.
(() => {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

  const answerEl = $<HTMLDivElement>("answer");
  const statusEl = $<HTMLDivElement>("status");
  const noteEl = $<HTMLTextAreaElement>("note");
  const sendShotEl = $<HTMLInputElement>("sendWithShot");
  const hintEl = $<HTMLDivElement>("hint");
  const retryBtn = $<HTMLButtonElement>("btnRetry");

  let raw = ""; // the answer text so far, as Markdown
  let questionHtml = ""; // the typed question shown above the answer
  let busy = false;
  let lastAsk: { note?: string; screenshot: boolean } | null = null; // for Retry

  function setStatus(text: string) {
    statusEl.textContent = text;
  }

  function setBusy(b: boolean) {
    busy = b;
    document.body.classList.toggle("busy", b);
  }

  /**
   * Redraw the answer at most once per screen refresh (~60 times a second).
   * Text can arrive in many tiny pieces; redrawing on every piece is wasted
   * work. requestAnimationFrame runs our callback right before the next
   * repaint, and `drawPending` makes sure we only ever queue one.
   */
  let drawPending = false;
  function scheduleDraw() {
    if (drawPending) return;
    drawPending = true;
    requestAnimationFrame(() => {
      drawPending = false;
      answerEl.innerHTML = questionHtml + renderMarkdown(raw);
    });
  }

  async function ask(opts: { note?: string; screenshot: boolean }) {
    if (!opts.note && !opts.screenshot) return;
    lastAsk = opts;
    retryBtn.hidden = true;
    await window.api.ask(opts);
  }

  /**
   * Send what's typed in the box.
   * `screenshot` is decided by the caller:
   *  - the "Send" button and Enter follow the "Send also takes a screenshot" box;
   *  - the "Screenshot + ask" button and the hotkey always take one.
   */
  function send(screenshot: boolean) {
    const note = noteEl.value.trim() || undefined;
    if (!note && !screenshot) return;
    noteEl.value = "";
    ask({ note, screenshot });
  }

  // --- buttons and keys
  $("btnSend").addEventListener("click", () => send(sendShotEl.checked));
  $("btnShot").addEventListener("click", () => send(true));
  retryBtn.addEventListener("click", () => lastAsk && ask(lastAsk));
  $("btnSettings").addEventListener("click", () => window.api.openSettings());
  $("btnClear").addEventListener("click", () => window.api.clear());
  $("btnHide").addEventListener("click", () => window.api.hide());
  $("btnStop").addEventListener("click", () => window.api.cancel());

  noteEl.addEventListener("keydown", (e) => {
    // Enter sends (same as the Send button), Shift+Enter makes a new line.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(sendShotEl.checked);
    }
  });

  // --- events from the main process
  window.api.on("hotkey:answer", () => send(true));
  window.api.on("hotkey:type", () => noteEl.focus());

  window.api.on("answer:start", (info: { note?: string; screenshot: boolean }) => {
    raw = "";
    questionHtml = info.note ? `<div class="q">${renderMarkdown(info.note)}</div>` : "";
    answerEl.innerHTML = questionHtml;
    setBusy(true);
    setStatus(info.screenshot ? "Capturing screen…" : "Thinking…");
  });

  window.api.on("answer:chunk", (chunk: string) => {
    raw += chunk;
    setStatus("Answering…");
    scheduleDraw();
    answerEl.scrollTop = 0; // keep the "Say:" line in view
  });

  window.api.on("answer:done", () => {
    setBusy(false);
    setStatus("Ready");
  });

  window.api.on("answer:error", (msg: string) => {
    setBusy(false);
    setStatus("Error");
    // Keep whatever part of the answer already arrived, and add the error under it.
    answerEl.innerHTML = questionHtml + renderMarkdown(raw) + `<p class="error">${escapeHtml(msg)}</p>`;
    retryBtn.hidden = !lastAsk;
  });

  window.api.on("status", (msg: string) => setStatus(msg));

  window.api.on("cleared", () => {
    raw = "";
    questionHtml = "";
    lastAsk = null;
    retryBtn.hidden = true;
    setBusy(false);
    answerEl.innerHTML = "";
    setStatus("New session: earlier questions forgotten");
  });

  async function showHints(s?: PublicSettings) {
    s = s ?? (await window.api.getSettings());
    const pretty = (a: string) => escapeHtml(a.replace("CommandOrControl", "Ctrl"));
    hintEl.innerHTML =
      `<span><b>${pretty(s.hotkeyAnswer)}</b> screenshot</span>` +
      `<span><b>${pretty(s.hotkeyType)}</b> type</span>` +
      `<span><b>${pretty(s.hotkeyToggle)}</b> hide</span>` +
      `<span><b>${pretty(s.hotkeyClear)}</b> reset</span>`;
    const model = s.provider === "anthropic" ? s.anthropicModel : s.openaiModel;
    setStatus(busy ? statusEl.textContent || "" : `Ready · ${model}`);
  }
  window.api.on("settings:changed", (s: PublicSettings) => showHints(s));
  showHints();
})();
