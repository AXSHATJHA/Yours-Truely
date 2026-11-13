/**
 * Settings storage.
 *
 * Settings live in a JSON file in Electron's per-user data folder
 * (on Windows: %APPDATA%\yours-truely\settings.json).
 *
 * API keys are NOT stored as plain text. Electron's `safeStorage` encrypts
 * them using the operating system's own protection (DPAPI on Windows), which
 * ties the encrypted value to your Windows user account. Another user, or a
 * copy of the file on another machine, can't decrypt it.
 */
import { app, safeStorage } from "electron";
import fs from "fs";
import path from "path";

export type Provider = "anthropic" | "openai-compatible";
export type Effort = "low" | "medium" | "high";

export interface Settings {
  provider: Provider;
  anthropicModel: string;
  effort: Effort;
  openaiBaseUrl: string;
  openaiModel: string;
  profile: string;
  interviewContext: string;
  hotkeyAnswer: string;
  hotkeyToggle: string;
  hotkeyClear: string;
  hotkeyType: string;
}

/** What the settings window sees: real keys are never sent back, only whether one is set. */
export interface PublicSettings extends Settings {
  hasAnthropicKey: boolean;
  hasOpenaiKey: boolean;
  encryptionAvailable: boolean;
}

export const DEFAULTS: Settings = {
  provider: "anthropic",
  anthropicModel: "claude-haiku-5-5",
  effort: "low",
  openaiBaseUrl: "http://localhost:11434/v1",
  openaiModel: "qwen2.5vl:7b",
  profile: "",
  interviewContext: "",
  hotkeyAnswer: "CommandOrControl+Shift+Space",
  hotkeyToggle: "CommandOrControl+Shift+H",
  hotkeyClear: "CommandOrControl+Shift+Backspace",
  hotkeyType: "CommandOrControl+Shift+N",
};

interface FileShape extends Partial<Settings> {
  anthropicKeyEnc?: string;
  openaiKeyEnc?: string;
}

const file = () => path.join(app.getPath("userData"), "settings.json");

/**
 * Reads the settings file.
 *
 * If the file is missing, that's a normal first run: return {}.
 * If it exists but is broken (not valid JSON), we must NOT return {} and carry
 * on, because the next save would then overwrite your profile and keys with
 * empty defaults. Instead: set the broken file aside (so nothing is lost and
 * you can inspect it), then fall back to the last good backup if there is one.
 */
function readFile(): FileShape {
  const f = file();
  if (!fs.existsSync(f)) return {};
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    try {
      fs.renameSync(f, `${f}.corrupt-${Date.now()}`);
    } catch {
      /* best effort */
    }
    try {
      const backup = JSON.parse(fs.readFileSync(`${f}.bak`, "utf8"));
      writeFile(backup); // restore the backup as the live file
      return backup;
    } catch {
      return {};
    }
  }
}

/**
 * Writes the settings file safely ("atomic write").
 *
 * Writing straight into settings.json is risky: if the app is killed halfway,
 * the file is left half-written and unreadable. Instead we:
 *   1. write the new content to settings.json.tmp,
 *   2. copy the current good file to settings.json.bak,
 *   3. rename the .tmp file over settings.json.
 * A rename either happens completely or not at all, so settings.json is
 * always either the old version or the new one, never a broken mix.
 */
function writeFile(data: FileShape) {
  const f = file();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  if (fs.existsSync(f)) {
    try {
      fs.copyFileSync(f, `${f}.bak`);
    } catch {
      /* a missing backup shouldn't block saving */
    }
  }
  fs.renameSync(tmp, f);
}

function encrypt(plain: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return "enc:" + safeStorage.encryptString(plain).toString("base64");
  }
  // Fallback when the OS offers no encryption (rare on Windows).
  return "raw:" + Buffer.from(plain, "utf8").toString("base64");
}

function decrypt(stored?: string): string {
  if (!stored) return "";
  try {
    if (stored.startsWith("enc:")) {
      return safeStorage.decryptString(Buffer.from(stored.slice(4), "base64"));
    }
    if (stored.startsWith("raw:")) {
      return Buffer.from(stored.slice(4), "base64").toString("utf8");
    }
  } catch {
    /* unreadable key: treat as unset */
  }
  return "";
}

export function getSettings(): Settings {
  const data = readFile();
  const out = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS) as (keyof Settings)[]) {
    if (data[k] !== undefined) (out as any)[k] = data[k];
  }
  return out;
}

export function getPublicSettings(): PublicSettings {
  const data = readFile();
  return {
    ...getSettings(),
    hasAnthropicKey: !!decrypt(data.anthropicKeyEnc),
    hasOpenaiKey: !!decrypt(data.openaiKeyEnc),
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
  };
}

export function getKeys() {
  const data = readFile();
  return {
    anthropicKey: decrypt(data.anthropicKeyEnc),
    openaiKey: decrypt(data.openaiKeyEnc),
  };
}

/**
 * Save settings. For the keys, `undefined` means "leave unchanged", an empty
 * string means "delete", anything else replaces the stored key.
 */
export function saveSettings(
  patch: Partial<Settings>,
  keys: { anthropicKey?: string; openaiKey?: string } = {}
) {
  const data = readFile();
  for (const k of Object.keys(DEFAULTS) as (keyof Settings)[]) {
    if (patch[k] !== undefined) (data as any)[k] = patch[k];
  }
  if (keys.anthropicKey !== undefined) {
    data.anthropicKeyEnc = keys.anthropicKey ? encrypt(keys.anthropicKey.trim()) : undefined;
  }
  if (keys.openaiKey !== undefined) {
    data.openaiKeyEnc = keys.openaiKey ? encrypt(keys.openaiKey.trim()) : undefined;
  }
  writeFile(data);
}
