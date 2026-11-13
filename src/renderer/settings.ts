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

  function ensureOption(select: HTMLSelectElement, value: string, suffix: string) {
    if (!value || [...select.options].some((o) => o.value === value)) return;
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = value + suffix;
    select.appendChild(opt);
  }

  function showProvider() {
    const p = val("provider");
    el("anthropicBox").hidden = p !== "anthropic";
    el("openaiBox").hidden = p !== "openai-compatible";
  }

  async function load() {
    const s = await window.api.getSettings();
    el<HTMLSelectElement>("provider").value = s.provider;
    // A dropdown can only show values it has an <option> for; setting any other
    // value makes it "" (empty), and saving would then store an empty model.
    // So if the saved model isn't in the list (hand-edited, or an older/newer
    // model id), add it as an extra option instead of losing it.
    ensureOption(el<HTMLSelectElement>("anthropicModel"), s.anthropicModel, " (saved)");
    ensureOption(el<HTMLSelectElement>("effort"), s.effort, "");
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
    // Never save an empty model name: keep whatever was stored before.
    if (!patch.anthropicModel) delete patch.anthropicModel;
    if (!patch.effort) delete patch.effort;
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
