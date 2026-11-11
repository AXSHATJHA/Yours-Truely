// The Settings window: profile, interview context, provider and hotkeys.
(() => {
  const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const val = (id: string) => el<HTMLInputElement>(id).value;

  const TEXT_FIELDS = [
    "profile",
    "interviewContext",
    "anthropicModel",
    "effort",
    "openaiBaseUrl",
    "openaiModel",
    "hotkeyAnswer",
    "hotkeyType",
    "hotkeyToggle",
    "hotkeyClear",
  ] as const;

  function showProvider() {
    const p = val("provider");
    el("anthropicBox").hidden = p !== "anthropic";
    el("openaiBox").hidden = p !== "openai-compatible";
  }

  async function load() {
    const s = await window.api.getSettings();
    el<HTMLSelectElement>("provider").value = s.provider;
    for (const f of TEXT_FIELDS) el<HTMLInputElement>(f).value = String(s[f] ?? "");
    el<HTMLInputElement>("anthropicKey").placeholder = s.hasAnthropicKey
      ? "Key saved. Leave empty to keep it."
      : "sk-ant-…";
    el<HTMLInputElement>("openaiKey").placeholder = s.hasOpenaiKey
      ? "Key saved. Leave empty to keep it."
      : "Not needed for Ollama";
    el("encWarn").hidden = s.encryptionAvailable;
    showProvider();
  }

  async function save() {
    const patch: Record<string, string> = { provider: val("provider") };
    for (const f of TEXT_FIELDS) patch[f] = val(f);
    const keys: { anthropicKey?: string; openaiKey?: string } = {};
    if (val("anthropicKey")) keys.anthropicKey = val("anthropicKey");
    if (val("openaiKey")) keys.openaiKey = val("openaiKey");
    const res = await window.api.saveSettings(patch as Partial<PublicSettings>, keys);
    el<HTMLInputElement>("anthropicKey").value = "";
    el<HTMLInputElement>("openaiKey").value = "";
    const msg = el("saved");
    msg.textContent = res.failedHotkeys.length
      ? `Saved, but these hotkeys couldn't be registered (taken or invalid): ${res.failedHotkeys.join(", ")}`
      : "Saved ✓";
    msg.className = res.failedHotkeys.length ? "warn" : "ok";
    await load();
  }

  el("provider").addEventListener("change", showProvider);
  el("btnSave").addEventListener("click", save);
  el("btnClearContext").addEventListener("click", () => {
    el<HTMLTextAreaElement>("interviewContext").value = "";
  });
  el("btnForgetAnthropic").addEventListener("click", async () => {
    await window.api.saveSettings({}, { anthropicKey: "" });
    await load();
  });
  el("btnForgetOpenai").addEventListener("click", async () => {
    await window.api.saveSettings({}, { openaiKey: "" });
    await load();
  });
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key === "s") {
      e.preventDefault();
      save();
    }
  });

  load();
})();
