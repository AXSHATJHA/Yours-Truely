// Types for `window.api`, the bridge defined in src/preload.ts.

interface PublicSettings {
  provider: "anthropic" | "openai-compatible";
  anthropicModel: string;
  effort: "low" | "medium" | "high";
  openaiBaseUrl: string;
  openaiModel: string;
  profile: string;
  interviewContext: string;
  hotkeyAnswer: string;
  hotkeyToggle: string;
  hotkeyClear: string;
  hotkeyType: string;
  hasAnthropicKey: boolean;
  hasOpenaiKey: boolean;
  encryptionAvailable: boolean;
}

interface Window {
  api: {
    ask(opts: { note?: string; screenshot: boolean }): Promise<void>;
    cancel(): Promise<void>;
    clear(): Promise<void>;
    openSettings(): Promise<void>;
    hide(): Promise<void>;
    quit(): Promise<void>;
    getSettings(): Promise<PublicSettings>;
    saveSettings(
      patch: Partial<PublicSettings>,
      keys: { anthropicKey?: string; openaiKey?: string }
    ): Promise<{ failedHotkeys: string[] }>;
    on(event: string, fn: (...args: any[]) => void): void;
  };
}
