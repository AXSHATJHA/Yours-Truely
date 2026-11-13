/**
 * Electron "main process": the part of the app that runs Node.js and controls
 * the operating system side of things (windows, global hotkeys, screenshots,
 * network calls to the AI). The windows themselves ("renderer processes") are
 * web pages that ask the main process to do things through IPC (inter-process
 * communication: named messages sent between the two sides).
 *
 * Flow when you press the answer hotkey:
 *   hotkey -> main tells the overlay "triggered" -> overlay replies with
 *   ask({ note, screenshot: true }) -> main hides the overlay for a moment,
 *   captures the screen, shows it again -> sends screenshot + prompts to the
 *   model -> streams the answer text back to the overlay as it arrives.
 */
import {
  app,
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  screen,
  shell,
} from "electron";
import path from "path";
import { buildSystemPrompt } from "./prompts";
import { friendlyError, streamAnswer, Turn } from "./providers";
import { getKeys, getPublicSettings, getSettings, saveSettings, Settings } from "./store";

let overlay: BrowserWindow | null = null;
let settingsWin: BrowserWindow | null = null;
let history: Turn[] = [];
let current: AbortController | null = null;

const rendererFile = (name: string) => path.join(__dirname, "renderer", name);
const preload = path.join(__dirname, "preload.js");

// Only one copy of the app at a time; a second launch focuses the first.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => overlay?.show());
  app.whenReady().then(start);
}

function start() {
  createOverlay();
  registerHotkeys();
  const s = getPublicSettings();
  // First run: nothing configured yet, so open Settings straight away.
  if (!s.hasAnthropicKey && s.provider === "anthropic") openSettings();
}

// ------------------------------------------------------------------ windows

function createOverlay() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = 460;
  const height = 540;
  overlay = new BrowserWindow({
    width,
    height,
    x: workArea.x + workArea.width - width - 24,
    y: workArea.y + 24,
    minWidth: 320,
    minHeight: 200,
    frame: false, // we draw our own slim title bar
    alwaysOnTop: true, // stays above the meeting window
    skipTaskbar: false, // a normal, visible app in the taskbar
    backgroundColor: "#15171c",
    show: false,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  overlay.setAlwaysOnTop(true, "floating");
  overlay.loadFile(rendererFile("overlay.html"));
  overlay.once("ready-to-show", () => overlay?.show());
  overlay.on("closed", () => {
    overlay = null;
    app.quit();
  });
  blockNavigation(overlay);
}

function openSettings() {
  if (settingsWin) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 760,
    height: 820,
    title: "Yours Truely – Settings",
    backgroundColor: "#15171c",
    autoHideMenuBar: true,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  settingsWin.loadFile(rendererFile("settings.html"));
  settingsWin.on("closed", () => (settingsWin = null));
  blockNavigation(settingsWin);
}

/**
 * Links inside answers (rendered as <a target="_blank">) open in your normal
 * browser, never inside the app, and the window itself can never navigate away.
 */
function blockNavigation(win: BrowserWindow) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
}

// ------------------------------------------------------------------ hotkeys

/** Returns the hotkeys that could not be registered (usually taken by another app). */
function registerHotkeys(): string[] {
  globalShortcut.unregisterAll();
  const s = getSettings();
  const failed: string[] = [];
  const bind = (accel: string, fn: () => void) => {
    if (!accel) return;
    try {
      if (!globalShortcut.register(accel, fn)) failed.push(accel);
    } catch {
      failed.push(accel); // invalid key combination text
    }
  };
  bind(s.hotkeyAnswer, () => {
    if (!overlay) return;
    if (!overlay.isVisible()) overlay.showInactive(); // show without stealing focus
    overlay.webContents.send("hotkey:answer");
  });
  bind(s.hotkeyToggle, () => {
    if (!overlay) return;
    overlay.isVisible() ? overlay.hide() : overlay.showInactive();
  });
  bind(s.hotkeyClear, () => clearSession());
  bind(s.hotkeyType, () => {
    if (!overlay) return;
    overlay.show();
    overlay.focus();
    overlay.webContents.send("hotkey:type");
  });
  if (failed.length) overlay?.webContents.send("status", `Hotkey not available: ${failed.join(", ")}. Change it in Settings.`);
  return failed;
}

app.on("will-quit", () => globalShortcut.unregisterAll());

// --------------------------------------------------------------- screenshot

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The screenshot currently being taken, if any.
 *
 * Why this exists: a capture hides the overlay, waits, captures, then shows the
 * overlay again. If two captures overlapped, the first one would show the
 * overlay again while the second was still capturing, and the overlay would
 * end up in its own screenshot. So while one capture is running, any other
 * request simply waits for that same screenshot instead of starting a new one.
 */
let captureInFlight: Promise<string> | null = null;

function captureScreen(): Promise<string> {
  if (!captureInFlight) {
    captureInFlight = doCapture().finally(() => {
      captureInFlight = null;
    });
  }
  return captureInFlight;
}

/**
 * Captures the monitor the mouse is on and returns it as a JPEG (base64).
 *
 * The overlay is made fully transparent for a moment first, otherwise it would
 * appear in its own screenshot and cover part of the question.
 *
 * The image is scaled so its longest side is at most 1568 px. Claude scales
 * larger images down to about that size anyway, so sending more pixels would
 * only make the upload slower.
 */
async function doCapture(): Promise<string> {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { width, height } = display.size;
  const scale = display.scaleFactor;

  try {
    overlay?.setOpacity(0);
    await wait(120); // give Windows time to repaint without the overlay
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) },
    });
    const src = pickSource(sources, display);
    if (!src) throw new Error("No screen found to capture.");
    let img = src.thumbnail;
    const size = img.getSize();
    const longest = Math.max(size.width, size.height);
    if (longest > 1568) {
      const ratio = 1568 / longest;
      img = img.resize({
        width: Math.round(size.width * ratio),
        height: Math.round(size.height * ratio),
        quality: "best",
      });
    }
    return img.toJPEG(85).toString("base64");
  } finally {
    overlay?.setOpacity(1);
  }
}

/**
 * Finds the capture source for the monitor the mouse is on.
 *
 * Normally each source's `display_id` matches the monitor's id. On some Windows
 * setups `display_id` comes back empty, so we fall back to matching by
 * position in the list (Electron lists screens and displays in the same order
 * in practice). If even that is ambiguous we use the first screen, but say so
 * in the status line instead of failing silently.
 */
function pickSource(sources: Electron.DesktopCapturerSource[], display: Electron.Display) {
  const byId = sources.find((s) => s.display_id === String(display.id));
  if (byId) return byId;
  const displays = screen.getAllDisplays();
  const index = displays.findIndex((d) => d.id === display.id);
  if (sources.length === displays.length && index >= 0) return sources[index];
  if (sources.length > 1) {
    overlay?.webContents.send("status", "Couldn't tell which monitor you're on; captured the first one.");
  }
  return sources[0];
}

// --------------------------------------------------------------------- ask

async function ask(opts: { note?: string; screenshot: boolean }) {
  if (!overlay) return;
  const win = overlay;
  current?.abort(); // a new question cancels any answer still streaming
  const controller = new AbortController();
  current = controller;

  const note = opts.note?.trim() || undefined;
  if (!note && !opts.screenshot) return;

  const settings: Settings = getSettings();
  let answer = "";
  try {
    win.webContents.send("answer:start", { note, screenshot: opts.screenshot });
    const image = opts.screenshot ? await captureScreen() : undefined;
    if (controller.signal.aborted) return;
    win.webContents.send("status", "Thinking…");

    await streamAnswer({
      settings,
      keys: getKeys(),
      systemPrompt: buildSystemPrompt(settings.profile, settings.interviewContext),
      history,
      imageJpegBase64: image,
      note,
      signal: controller.signal,
      onText: (chunk) => {
        answer += chunk;
        win.webContents.send("answer:chunk", chunk);
      },
    });
    history.push({ question: note ?? "(screenshot of my screen)", answer });
    win.webContents.send("answer:done");
  } catch (err) {
    if (controller.signal.aborted) {
      win.webContents.send("answer:done");
      return;
    }
    win.webContents.send("answer:error", friendlyError(err));
  } finally {
    if (current === controller) current = null;
  }
}

function clearSession() {
  current?.abort();
  history = [];
  overlay?.webContents.send("cleared");
}

// --------------------------------------------------------------------- IPC

ipcMain.handle("ask", (_e, opts: { note?: string; screenshot: boolean }) => ask(opts));
ipcMain.handle("cancel", () => current?.abort());
ipcMain.handle("clear", () => clearSession());
ipcMain.handle("open-settings", () => openSettings());
ipcMain.handle("hide", () => overlay?.hide());
ipcMain.handle("quit", () => app.quit());
ipcMain.handle("settings:get", () => getPublicSettings());
ipcMain.handle(
  "settings:save",
  (_e, patch: Partial<Settings>, keys: { anthropicKey?: string; openaiKey?: string }) => {
    saveSettings(patch, keys);
    const failed = registerHotkeys();
    overlay?.webContents.send("settings:changed", getPublicSettings());
    return { failedHotkeys: failed };
  }
);
