/**
 * The "preload" script is a small bridge between the web page (the window you
 * see) and the main process. For security, the page can't use Node.js
 * directly; it only gets the specific functions listed here, exposed as
 * `window.api`.
 */
import { contextBridge, ipcRenderer, IpcRendererEvent } from "electron";

const EVENTS = [
  "hotkey:answer",
  "hotkey:type",
  "answer:start",
  "answer:chunk",
  "answer:done",
  "answer:error",
  "status",
  "cleared",
  "settings:changed",
] as const;

contextBridge.exposeInMainWorld("api", {
  ask: (opts: { note?: string; screenshot: boolean }) => ipcRenderer.invoke("ask", opts),
  cancel: () => ipcRenderer.invoke("cancel"),
  clear: () => ipcRenderer.invoke("clear"),
  openSettings: () => ipcRenderer.invoke("open-settings"),
  hide: () => ipcRenderer.invoke("hide"),
  quit: () => ipcRenderer.invoke("quit"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (patch: unknown, keys: unknown) => ipcRenderer.invoke("settings:save", patch, keys),
  on: (event: (typeof EVENTS)[number], fn: (...args: unknown[]) => void) => {
    if (!EVENTS.includes(event)) return;
    ipcRenderer.on(event, (_e: IpcRendererEvent, ...args: unknown[]) => fn(...args));
  },
});

// ------------------------------------------------------------------ voice
// A separate bridge for the voice feature (src/voice.ts), exposed as
// `window.voice`, so `window.api` above stays exactly as it was.
const VOICE_EVENTS = ["voice:state", "voice:transcript", "voice:hotkey-answer"] as const;

contextBridge.exposeInMainWorld("voice", {
  toggle: () => ipcRenderer.invoke("voice:toggle"),
  answer: (opts: { screenshot: boolean }) => ipcRenderer.invoke("voice:answer", opts),
  clear: () => ipcRenderer.invoke("voice:clear"),
  getState: () => ipcRenderer.invoke("voice:get-state"),
  // Used only by the hidden capture window; the main process ignores these from any other window.
  sendAudio: (who: "them" | "me", samples: Float32Array, sampleRate: number) =>
    ipcRenderer.send("voice:audio", who, samples, sampleRate),
  captureEnded: (message: string) => ipcRenderer.send("voice:capture-ended", message),
  on: (event: (typeof VOICE_EVENTS)[number], fn: (...args: unknown[]) => void) => {
    if (!VOICE_EVENTS.includes(event)) return;
    ipcRenderer.on(event, (_e: IpcRendererEvent, ...args: unknown[]) => fn(...args));
  },
});
