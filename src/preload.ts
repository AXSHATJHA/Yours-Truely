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
