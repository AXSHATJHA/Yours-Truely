// Types for the voice feature's bridge (`window.voice`, defined in src/preload.ts)
// and its settings. These add to the declarations in global.d.ts; TypeScript
// merges interfaces with the same name, so global.d.ts itself stays unchanged.

interface PublicSettings {
  hotkeyListen: string;
  hotkeyAnswerAudio: string;
  voiceIncludeMic: boolean;
  voiceModel: string;
  voiceLanguage: string;
  voiceAutoAnswer: boolean;
}

interface VoiceLine {
  who: "them" | "me";
  text: string;
  /** Not yet sent to the AI. */
  fresh: boolean;
}

interface VoiceState {
  listening: boolean;
  starting: boolean;
  message?: string;
  error?: boolean;
}

interface VoiceTranscript {
  lines: VoiceLine[];
  /** Pieces of audio still being transcribed. */
  pending: number;
}

interface Window {
  voice: {
    toggle(): Promise<void>;
    answer(opts: { screenshot: boolean }): Promise<void>;
    clear(): Promise<void>;
    getState(): Promise<VoiceState & VoiceTranscript>;
    sendAudio(who: "them" | "me", samples: Float32Array, sampleRate: number): void;
    captureEnded(message: string): void;
    on(event: string, fn: (...args: any[]) => void): void;
  };
  /** Only defined in the hidden capture window (voice-capture.ts). */
  voiceCapture?: {
    start(opts: { mic: boolean }): Promise<{ ok: boolean; error?: { name: string; message: string; stage: string } }>;
    stop(): void;
  };
}
