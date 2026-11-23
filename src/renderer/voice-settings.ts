// The "6. Voice" section of the Settings window.
// Loaded as its own script after settings.js, so settings.ts is untouched.
// It saves when you press the same Save button (or Ctrl+S): both scripts
// listen for it, and each saves its own fields.
(() => {
  const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const input = (id: string) => el<HTMLInputElement>(id);

  async function load() {
    const s = await window.api.getSettings();
    input("hotkeyListen").value = s.hotkeyListen ?? "";
    input("hotkeyAnswerAudio").value = s.hotkeyAnswerAudio ?? "";
    input("voiceIncludeMic").checked = !!s.voiceIncludeMic;
    input("voiceAutoAnswer").checked = !!s.voiceAutoAnswer;
    input("voiceLanguage").value = s.voiceLanguage ?? "";
    const model = el<HTMLSelectElement>("voiceModel");
    // Keep a hand-edited model id instead of silently blanking it.
    if (s.voiceModel && ![...model.options].some((o) => o.value === s.voiceModel)) {
      const opt = document.createElement("option");
      opt.value = s.voiceModel;
      opt.textContent = `${s.voiceModel} (saved)`;
      model.appendChild(opt);
    }
    model.value = s.voiceModel;
    el("voiceKeyWarn").hidden = s.hasGroqKey;
  }

  async function save() {
    const patch: Partial<PublicSettings> = {
      hotkeyListen: input("hotkeyListen").value.trim(),
      hotkeyAnswerAudio: input("hotkeyAnswerAudio").value.trim(),
      voiceIncludeMic: input("voiceIncludeMic").checked,
      voiceAutoAnswer: input("voiceAutoAnswer").checked,
      // Whisper wants a 2-letter code such as "en" or "hi"; blank = let it guess.
      voiceLanguage: input("voiceLanguage").value.trim().toLowerCase(),
    };
    const model = el<HTMLSelectElement>("voiceModel").value;
    if (model) patch.voiceModel = model;
    const res = await window.api.saveSettings(patch, {});
    const voiceKeys = [patch.hotkeyListen, patch.hotkeyAnswerAudio];
    const failed = res.failedHotkeys.filter((h) => voiceKeys.includes(h));
    const msg = el("voiceSaved");
    msg.textContent = failed.length ? `These voice hotkeys couldn't be registered: ${failed.join(", ")}` : "";
    msg.className = failed.length ? "warn" : "";
    await load();
  }

  el("btnSave").addEventListener("click", save);
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key === "s") save();
  });

  load();
})();
