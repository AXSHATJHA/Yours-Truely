// Types for `window.api`, the bridge defined in src/preload.ts.

interface PublicSettings {
  provider: "anthropic" | "groq" | "openai-compatible";
  anthropicModel: string;
  effort: "low" | "medium" | "high";
  openaiBaseUrl: string;
  openaiModel: string;
  groqModel: string;
  groqReasoningEffort: "none" | "low" | "medium" | "high" | "default";
  groqMaxTokens: number;
  profile: string;
  interviewContext: string;
  hotkeyAnswer: string;
  hotkeyToggle: string;
  hotkeyClear: string;
  hotkeyType: string;
  hideFromCapture: boolean;
  hasAnthropicKey: boolean;
  hasOpenaiKey: boolean;
  hasGroqKey: boolean;
  encryptionAvailable: boolean;
  captureExclusionSupported: boolean;
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
      keys: { anthropicKey?: string; openaiKey?: string; groqKey?: string }
    ): Promise<{ failedHotkeys: string[] }>;
    on(event: string, fn: (...args: any[]) => void): void;
  };
}
