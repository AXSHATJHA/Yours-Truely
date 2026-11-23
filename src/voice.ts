/**
 * Voice: listens to the meeting, turns speech into text, and hands that text
 * to the app's existing ask() pipeline when you press "Answer from audio".
 *
 * This file is the main-process side. It is self-contained: the rest of the
 * app only calls setupVoice() once at start-up and asks voiceHotkeys() for
 * two extra hotkeys. Nothing here changes how screenshots or typed questions
 * work.
 *
 * The pieces, in the order sound flows through them:
 *
 *  1. A hidden window (static/voice.html + src/renderer/voice-capture.ts)
 *     asks Chromium for the screen-share audio. The handler below answers
 *     with `audio: "loopback"`, which on Windows means "a copy of everything
 *     the PC is playing" (WASAPI loopback), so the interviewer's voice from
 *     Meet/Zoom/Teams. Optionally it also opens your microphone.
 *  2. That window streams raw samples here over IPC, labelled "them" (the
 *     meeting) or "me" (your mic).
 *  3. voice-audio.ts resamples to 16 kHz, cuts the stream at pauses, and
 *     wraps each piece as a WAV file.
 *  4. transcribe.ts sends each piece to Groq Whisper, one at a time, in order.
 *  5. The text is kept in a rolling transcript and shown in the answer window.
 *  6. "Answer from audio" sends the recent transcript to ask() as a typed note.
 */
import { app, BrowserWindow, desktopCapturer, ipcMain, session } from "electron";
import { getKeys, getSettings, Settings } from "./store";
import { isRetryable, transcribeWav } from "./transcribe";
import { cleanTranscript, concatSamples, encodeWav, looksLikeQuestion, Resampler, Segment, Segmenter } from "./voice-audio";

type Who = "them" | "me";

interface Line {
  who: Who;
  text: string;
  at: number; // when it was transcribed (ms since 1970)
}

export interface VoiceDeps {
  getOverlay: () => BrowserWindow | null;
  /** The app's existing ask(), used exactly as the text box uses it. */
  ask: (opts: { note?: string; screenshot: boolean }) => Promise<void>;
  rendererFile: (name: string) => string;
  preload: string;
}

/**
 * The capture window gets its own "partition" (a separate browser profile).
 * Its screen-share handler and permissions then apply to that window only,
 * never to the answer or settings windows.
 */
const PARTITION = "voice-capture";
/** "Answer from audio" only looks this far back, so an old chat doesn't confuse the model. */
const ANSWER_WINDOW_MS = 60_000;
/** Lines kept in memory. Older ones are dropped. */
const MAX_LINES = 200;
/** A piece that failed for a temporary reason is retried with the next one, up to this length. */
const MAX_CARRY_SAMPLES = 16000 * 30;

interface Pipe {
  rate: number;
  resampler: Resampler;
  segmenter: Segmenter;
  carry: Float32Array[]; // audio whose transcription failed temporarily; sent again with the next piece
}

let deps: VoiceDeps | null = null;
let captureWin: BrowserWindow | null = null;
let listening = false;
let starting = false;
let answering = false;
const pipes = new Map<Who, Pipe>();
let lines: Line[] = [];
let answeredUpTo = 0; // lines before this index were already sent to the AI
let generation = 0; // bumped on "new session" so late transcriptions from before are ignored
let queue: Promise<void> = Promise.resolve(); // transcriptions run one after another, in order
let inFlight = 0;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------- setup

export function setupVoice(d: VoiceDeps) {
  deps = d;
  const ses = session.fromPartition(PARTITION);

  // When the capture page calls getDisplayMedia(), Chromium asks us what to
  // share. We pick the first screen (required: Chromium always wants a video
  // source too) and ask for loopback audio, i.e. everything the PC plays.
  ses.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer
      .getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } })
      .then((sources) => callback(sources[0] ? { video: sources[0], audio: "loopback" } : null))
      .catch(() => callback(null));
  });
  // Only audio/video capture is allowed in this window; anything else is refused.
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === "media" || permission === "display-capture"));

  ipcMain.handle("voice:toggle", () => toggleListening());
  ipcMain.handle("voice:answer", (_e, opts?: { screenshot?: boolean }) => answerFromAudio(!!opts?.screenshot));
  ipcMain.handle("voice:clear", () => clearTranscript());
  ipcMain.handle("voice:get-state", () => ({ ...state(), ...transcript() }));

  // Raw audio from the capture window. Anything from another window is ignored.
  ipcMain.on("voice:audio", (e, who: unknown, samples: unknown, rate: unknown) => {
    if (!captureWin || e.sender !== captureWin.webContents) return;
    if ((who !== "them" && who !== "me") || !(samples instanceof Float32Array) || typeof rate !== "number") return;
    onAudio(who, samples, rate);
  });
  ipcMain.on("voice:capture-ended", (e, message: unknown) => {
    if (!captureWin || e.sender !== captureWin.webContents) return;
    stopListening(typeof message === "string" ? message : "Audio capture stopped.", true);
  });

  app.on("will-quit", () => destroyCapture());
}

/** The two voice hotkeys, registered by main.ts inside its own registerHotkeys(). */
export function voiceHotkeys(s: Settings): Array<[string, () => void]> {
  return [
    [s.hotkeyListen, () => toggleListening()],
    [
      s.hotkeyAnswerAudio,
      () => {
        const o = deps?.getOverlay();
        if (!o) return;
        if (!o.isVisible()) o.showInactive();
        // The answer window decides whether to add a screenshot (its checkbox).
        o.webContents.send("voice:hotkey-answer");
      },
    ],
  ];
}

// ------------------------------------------------------------- start / stop

export async function toggleListening() {
  if (listening) stopListening();
  else await startListening();
}

async function startListening() {
  if (listening || starting || !deps) return;
  const s = getSettings();
  if (!getKeys().groqKey) {
    sendState(
      "Voice needs a Groq API key for transcription. Add one in Settings → AI model → Groq (answers can still come from Claude).",
      true
    );
    return;
  }
  starting = true;
  sendState("Starting…");
  try {
    const win = new BrowserWindow({
      show: false, // never shown: it only holds the audio streams
      width: 200,
      height: 100,
      skipTaskbar: true,
      webPreferences: {
        preload: deps.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition: PARTITION,
        // Chromium slows down hidden windows to save power; audio must not be slowed.
        backgroundThrottling: false,
      },
    });
    captureWin = win;
    win.on("closed", () => {
      if (captureWin === win) captureWin = null;
      if (listening) stopListening("Audio capture stopped unexpectedly.", true);
    });
    await win.loadFile(deps.rendererFile("voice.html"));
    pipes.clear();
    // `true` = run as if from a user click. Chromium only lets a page start a
    // screen/audio capture in response to a user action, and pressing Listen is one.
    const res = (await win.webContents.executeJavaScript(
      `window.voiceCapture.start(${JSON.stringify({ mic: !!s.voiceIncludeMic })})`,
      true
    )) as { ok: boolean; error?: CaptureError };
    if (!res?.ok) throw res?.error ?? { name: "Error", message: "Couldn't start audio capture.", stage: "setup" };
    listening = true;
    sendState(s.voiceIncludeMic ? "Listening to the meeting and your mic" : "Listening to the meeting");
  } catch (err) {
    destroyCapture();
    sendState(captureErrorMessage(err), true);
  } finally {
    starting = false;
  }
}

function stopListening(message = "Stopped listening", isError = false) {
  if (!listening && !captureWin) return;
  listening = false;
  // Whatever was being said when you pressed stop still gets transcribed.
  for (const [who, p] of pipes) {
    const seg = p.segmenter.flush();
    if (seg) enqueue(who, seg);
  }
  destroyCapture();
  sendState(message, isError);
}

/** Closing the hidden window ends its audio streams and releases the devices. */
function destroyCapture() {
  const w = captureWin;
  captureWin = null;
  if (w && !w.isDestroyed()) w.destroy();
}

interface CaptureError {
  name: string;
  message: string;
  stage: "setup" | "system" | "mic";
}

function captureErrorMessage(err: unknown): string {
  const e = (err ?? {}) as Partial<CaptureError>;
  const what = e.stage === "mic" ? "your microphone" : "the meeting audio";
  if (e.name === "NotAllowedError")
    return e.stage === "mic"
      ? "Windows blocked the microphone. Turn on Settings → Privacy & security → Microphone → Let desktop apps access your microphone."
      : "Windows refused to share system audio.";
  if (e.name === "NotReadableError") return `Couldn't open ${what}: another app may be using the device exclusively.`;
  if (e.name === "NotFoundError") return e.stage === "mic" ? "No microphone was found." : "No audio output device was found.";
  if (e.name === "NoAudio") return "No system audio came through. Loopback capture needs Windows 10 or 11.";
  return `Couldn't capture ${what}: ${e.message || String(err)}`;
}

// ------------------------------------------------------------ audio → text

function onAudio(who: Who, samples: Float32Array, rate: number) {
  if (!listening) return;
  let p = pipes.get(who);
  if (!p || p.rate !== rate) {
    p = { rate, resampler: new Resampler(rate), segmenter: new Segmenter(), carry: [] };
    pipes.set(who, p);
  }
  for (const seg of p.segmenter.push(p.resampler.push(samples))) enqueue(who, seg);
}

/** Adds a piece to the transcription queue. The queue never rejects. */
function enqueue(who: Who, seg: Segment): Promise<void> {
  const gen = generation;
  inFlight++;
  sendTranscript();
  queue = queue
    .then(() => transcribeSegment(who, seg, gen))
    .finally(() => {
      inFlight--;
      sendTranscript();
    });
  return queue;
}

async function transcribeSegment(who: Who, seg: Segment, gen: number) {
  if (gen !== generation) return;
  const p = pipes.get(who);
  const audio = p?.carry.length ? concatSamples([...p.carry, seg.samples]) : seg.samples;
  if (p) p.carry = [];
  const s = getSettings();
  try {
    const raw = await transcribeWav({
      wav: encodeWav(audio),
      apiKey: getKeys().groqKey,
      model: s.voiceModel,
      language: s.voiceLanguage?.trim().toLowerCase() || undefined,
      prompt: whisperHint(s),
    });
    if (gen !== generation) return; // a new session started meanwhile
    const text = cleanTranscript(raw);
    if (!text) return;
    addLine(who, text);
    // Optional auto-answer: the interviewer paused after something that looks
    // like a question, and hasn't started talking again while we transcribed.
    if (
      s.voiceAutoAnswer &&
      who === "them" &&
      seg.endedOnPause &&
      looksLikeQuestion(text) &&
      !pipes.get("them")?.segmenter.inSpeech
    ) {
      void answerFromAudio(false);
    }
  } catch (err) {
    // Temporary problem (rate limit, network): keep the audio and send it again
    // together with the next piece, so no words are lost.
    if (isRetryable(err) && p && audio.length < MAX_CARRY_SAMPLES) p.carry.push(audio);
    sendState(err instanceof Error ? err.message : String(err), true);
  }
}

/**
 * The hint given to Whisper: the start of your interview notes (company, role,
 * names) and the most recent words heard. Whisper then spells names and jargon
 * consistently, and continues sentences that were cut between pieces.
 */
function whisperHint(s: Settings): string {
  const context = (s.interviewContext || "").replace(/\s+/g, " ").trim().slice(0, 200);
  const recent = lines
    .slice(-4)
    .map((l) => l.text)
    .join(" ")
    .slice(-350);
  return [context, recent].filter(Boolean).join(" ");
}

function addLine(who: Who, text: string) {
  lines.push({ who, text, at: Date.now() });
  if (lines.length > MAX_LINES) {
    const drop = lines.length - MAX_LINES;
    lines = lines.slice(drop);
    answeredUpTo = Math.max(0, answeredUpTo - drop);
  }
  sendTranscript();
}

// ----------------------------------------------------------------- answer

/**
 * Sends what was heard to the AI through the existing ask(), as a typed note.
 * From there it's the normal pipeline: same prompts, profile, history, provider.
 */
export async function answerFromAudio(screenshot: boolean) {
  if (!deps || answering) return;
  answering = true;
  try {
    // 1. End the piece being spoken right now, so its words are included.
    for (const [who, p] of pipes) {
      const seg = p.segmenter.flush();
      if (seg) enqueue(who, seg);
    }
    // 2. Wait for transcriptions still running (at most 8 s).
    if (inFlight > 0) sendState(listening ? "Finishing the transcript…" : "Transcribing…");
    await Promise.race([queue, wait(8000)]);

    // 3. Take what's new since the last answer, from the last minute.
    const now = Date.now();
    const recent = (l: Line) => now - l.at <= ANSWER_WINDOW_MS;
    let pick = lines.slice(answeredUpTo).filter(recent);
    // Nothing new? Answer the last few lines again (e.g. you pressed twice on purpose).
    if (!pick.length) pick = lines.filter(recent).slice(-4);
    if (!pick.length) {
      sendState(listening ? "Nothing heard yet in the last minute." : "Press Listen first, then ask again after the question.", !listening);
      return;
    }
    answeredUpTo = lines.length;
    sendTranscript();
    sendState(listening ? "Listening to the meeting" : "Stopped listening");
    await deps.ask({ note: formatNote(pick), screenshot });
  } finally {
    answering = false;
  }
}

export function formatNote(pick: { who: Who; text: string }[]): string {
  const name = (w: Who) => (w === "me" ? "Me" : "Interviewer");
  return (
    "Live transcript of what was just said in the interview (automatic speech-to-text, so a word may be wrong):\n" +
    pick.map((l) => `${name(l.who)}: ${l.text}`).join("\n") +
    "\n\nAnswer the interviewer's latest question."
  );
}

function clearTranscript() {
  generation++;
  lines = [];
  answeredUpTo = 0;
  for (const p of pipes.values()) p.carry = [];
  sendTranscript();
}

// ---------------------------------------------------------- to the window

function state() {
  return { listening, starting };
}

function transcript() {
  const start = Math.max(0, lines.length - 12);
  return {
    lines: lines.slice(start).map((l, i) => ({ who: l.who, text: l.text, fresh: start + i >= answeredUpTo })),
    pending: inFlight,
  };
}

function sendState(message?: string, error = false) {
  deps?.getOverlay()?.webContents.send("voice:state", { ...state(), message, error });
}

function sendTranscript() {
  deps?.getOverlay()?.webContents.send("voice:transcript", transcript());
}
