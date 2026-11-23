// Voice controls in the answer window: the 🎙 Listen button, the live
// transcript strip and the "Answer from audio" button.
// Loaded as its own script after overlay.js, so overlay.ts is untouched.
(() => {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

  const listenBtn = $<HTMLButtonElement>("btnListen");
  const strip = $<HTMLElement>("voiceStrip");
  const statusEl = $<HTMLSpanElement>("voiceStatus");
  const linesEl = $<HTMLDivElement>("voiceTranscript");
  const answerBtn = $<HTMLButtonElement>("btnVoiceAnswer");
  const hintEl = $<HTMLDivElement>("voiceHint");
  // The existing "Send also takes a screenshot" box. Answer from audio follows it too.
  const withShot = document.getElementById("sendWithShot") as HTMLInputElement | null;

  let listening = false;
  let hasLines = false;
  let hasMessage = false;

  function refreshVisibility() {
    strip.hidden = !(listening || hasLines || hasMessage);
    document.body.classList.toggle("listening", listening);
    listenBtn.title = listening ? "Stop listening" : "Listen to the meeting";
    listenBtn.setAttribute("aria-pressed", String(listening));
  }

  function showState(s: VoiceState) {
    listening = s.listening;
    if (s.message) {
      statusEl.textContent = s.message;
      hasMessage = true;
    } else if (s.starting) {
      statusEl.textContent = "Starting…";
    }
    statusEl.classList.toggle("error", !!s.error);
    refreshVisibility();
  }

  function showTranscript(t: VoiceTranscript) {
    // Built with textContent, never innerHTML: the transcript is outside text.
    linesEl.replaceChildren(
      ...t.lines.map((l) => {
        const row = document.createElement("div");
        row.className = `vline ${l.who}${l.fresh ? " fresh" : ""}`;
        const who = document.createElement("b");
        who.textContent = l.who === "me" ? "Me: " : "Them: ";
        row.append(who, document.createTextNode(l.text));
        return row;
      })
    );
    if (t.pending > 0) {
      const row = document.createElement("div");
      row.className = "vline pending";
      row.textContent = "…";
      linesEl.append(row);
    }
    linesEl.scrollTop = linesEl.scrollHeight; // newest at the bottom, in view
    hasLines = t.lines.length > 0;
    refreshVisibility();
  }

  function answer() {
    window.voice.answer({ screenshot: !!withShot?.checked });
  }

  async function showHints(s?: PublicSettings) {
    s = s ?? (await window.api.getSettings());
    const pretty = (a: string) => (a || "").replace("CommandOrControl", "Ctrl");
    hintEl.textContent = `${pretty(s.hotkeyListen)} listen on/off · ${pretty(s.hotkeyAnswerAudio)} answer from audio`;
  }

  listenBtn.addEventListener("click", () => window.voice.toggle());
  answerBtn.addEventListener("click", answer);
  window.voice.on("voice:hotkey-answer", answer);
  window.voice.on("voice:state", showState);
  window.voice.on("voice:transcript", showTranscript);
  // The existing New session (⟲ / hotkey) also clears what was heard.
  window.api.on("cleared", () => {
    hasMessage = false;
    window.voice.clear();
  });
  window.api.on("settings:changed", (s: PublicSettings) => showHints(s));

  window.voice.getState().then((s) => {
    showState({ listening: s.listening, starting: s.starting });
    showTranscript(s);
  });
  showHints();
})();
