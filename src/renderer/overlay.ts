(() => {
// The small always-on-top answer window.

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const answerEl = $<HTMLDivElement>("answer");
const statusEl = $<HTMLDivElement>("status");
const noteEl = $<HTMLTextAreaElement>("note");
const shotEl = $<HTMLInputElement>("withShot");
const hintEl = $<HTMLDivElement>("hint");

let raw = ""; // the answer text so far, as Markdown
let busy = false;

/**
 * A tiny Markdown renderer for the few things answers use: **bold**, `code`,
 * code blocks, and "- " bullets. Text is HTML-escaped first, so nothing in an
 * answer can inject HTML into the window.
 */
function render(md: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s: string) =>
    esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, "$1<em>$2</em>");

  const out: string[] = [];
  const lines = md.split("\n");
  let inCode = false;
  let code: string[] = [];
  let inList = false;
  const closeList = () => {
    if (inList) out.push("</ul>");
    inList = false;
  };
  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      if (inCode) {
        out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
        code = [];
        inCode = false;
      } else {
        closeList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    if (bullet) {
      if (!inList) out.push("<ul>");
      inList = true;
      out.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }
    closeList();
    if (line.trim()) out.push(`<p>${inline(line.replace(/^#+\s*/, ""))}</p>`);
  }
  if (inCode) out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`); // still streaming
  closeList();
  return out.join("");
}

function setStatus(text: string) {
  statusEl.textContent = text;
}

function setBusy(b: boolean) {
  busy = b;
  document.body.classList.toggle("busy", b);
}

async function send(screenshot: boolean) {
  const note = noteEl.value.trim();
  if (!note && !screenshot) return;
  noteEl.value = "";
  await window.api.ask({ note: note || undefined, screenshot });
}

// --- buttons and keys
$("btnShot").addEventListener("click", () => send(true));
$("btnSettings").addEventListener("click", () => window.api.openSettings());
$("btnClear").addEventListener("click", () => window.api.clear());
$("btnHide").addEventListener("click", () => window.api.hide());
$("btnStop").addEventListener("click", () => window.api.cancel());

noteEl.addEventListener("keydown", (e) => {
  // Enter sends, Shift+Enter makes a new line.
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send(shotEl.checked);
  }
});

// --- events from the main process
window.api.on("hotkey:answer", () => send(true));
window.api.on("hotkey:type", () => noteEl.focus());

window.api.on("answer:start", (info: { note?: string; screenshot: boolean }) => {
  raw = "";
  answerEl.innerHTML = info.note ? `<div class="q">${render(info.note)}</div>` : "";
  setBusy(true);
  setStatus(info.screenshot ? "Capturing screen…" : "Thinking…");
});

let qHtml = "";
window.api.on("answer:chunk", (chunk: string) => {
  if (!raw) qHtml = answerEl.querySelector(".q")?.outerHTML ?? "";
  raw += chunk;
  setStatus("Answering…");
  answerEl.innerHTML = qHtml + render(raw);
  answerEl.scrollTop = 0; // keep the "Say:" line in view
});

window.api.on("answer:done", () => {
  setBusy(false);
  setStatus("Ready");
});

window.api.on("answer:error", (msg: string) => {
  setBusy(false);
  setStatus("Error");
  answerEl.innerHTML = `<p class="error">${msg.replace(/</g, "&lt;")}</p>`;
});

window.api.on("status", (msg: string) => setStatus(msg));

window.api.on("cleared", () => {
  raw = "";
  setBusy(false);
  answerEl.innerHTML = "";
  setStatus("New session: earlier questions forgotten");
});

async function showHints(s?: PublicSettings) {
  s = s ?? (await window.api.getSettings());
  const pretty = (a: string) => a.replace("CommandOrControl", "Ctrl");
  hintEl.innerHTML =
    `<b>${pretty(s.hotkeyAnswer)}</b> screenshot + answer · ` +
    `<b>${pretty(s.hotkeyType)}</b> type a question · ` +
    `<b>${pretty(s.hotkeyToggle)}</b> show/hide · ` +
    `<b>${pretty(s.hotkeyClear)}</b> new session`;
  const model = s.provider === "anthropic" ? s.anthropicModel : s.openaiModel;
  setStatus(busy ? statusEl.textContent || "" : `Ready · ${model}`);
}
window.api.on("settings:changed", (s: PublicSettings) => showHints(s));
showHints();
})();
