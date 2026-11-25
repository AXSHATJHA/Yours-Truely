/**
 * Pure audio helpers for the voice feature. Nothing in here touches Electron,
 * the network or the screen, so every function can be unit-tested with
 * generated sound (see test/voice-audio.test.js).
 *
 * The journey of the sound, and which piece does what:
 *
 *   capture window ──Float32 samples at the device rate (often 48 kHz)──▶
 *     Resampler   : 48 000 samples/s ─▶ 16 000 samples/s (what Whisper uses)
 *     Segmenter   : decides where speech starts and stops, and cuts the
 *                   endless stream into one piece per sentence or pause
 *     encodeWav   : wraps one piece in a WAV header so it is a real audio file
 *   ──▶ transcribe.ts sends that file to Groq Whisper.
 *
 * "Sample": the microphone/speaker signal is a wave. A sample is one
 * measurement of that wave's height, a number between -1 and 1.
 * "Sample rate": how many measurements per second. 16 000 per second is
 * enough for speech, because the useful parts of a voice are under 8 kHz
 * (a rate captures sounds up to half its value).
 */

/** Whisper works at 16 kHz internally, so anything higher only makes uploads bigger. */
export const TARGET_RATE = 16000;

// ------------------------------------------------------------------ resample

/**
 * Converts audio from one sample rate to another, block by block.
 *
 * Why a class: audio arrives in small blocks (a few thousand samples). With a
 * ratio like 48 000 → 16 000 = 3 that divides evenly, but 44 100 → 16 000 =
 * 2.75625 doesn't. So a block can end "between" two output samples, and we
 * keep the leftover input (and the fractional position) for the next block.
 * Treating each block separately would add tiny clicks at every block edge.
 *
 * How: each output sample is the AVERAGE of the input samples it covers
 * (3 of them for 48 kHz). Averaging is a simple low-pass filter: it removes
 * high pitches that 16 kHz can't represent. Without it they would "fold
 * back" as hiss in the speech range (this is called aliasing).
 */
export class Resampler {
  private readonly ratio: number;
  private rest = new Float32Array(0);
  // Counted over the whole stream, so the position of each output sample is
  // exact (produced × ratio) and doesn't drift with how blocks are split.
  private produced = 0; // output samples made so far
  private dropped = 0; // input samples already used and thrown away

  constructor(inRate: number, outRate = TARGET_RATE) {
    if (!(inRate > 0) || !(outRate > 0)) throw new Error("Sample rates must be positive.");
    this.ratio = inRate / outRate;
  }

  push(block: Float32Array): Float32Array {
    if (this.ratio === 1) return block;
    const buf = new Float32Array(this.rest.length + block.length);
    buf.set(this.rest, 0);
    buf.set(block, this.rest.length);

    const r = this.ratio;
    const out: number[] = [];
    for (;;) {
      // Where output sample number `produced` starts and ends, in input samples.
      const a = Math.floor(this.produced * r) - this.dropped;
      const b = Math.floor((this.produced + 1) * r) - this.dropped;
      if (Math.max(a + 1, b) > buf.length) break; // not enough input yet
      if (b <= a) {
        out.push(buf[a]); // upsampling (input slower than 16 kHz): reuse the nearest sample
      } else {
        let sum = 0;
        for (let i = a; i < b; i++) sum += buf[i];
        out.push(sum / (b - a));
      }
      this.produced++;
    }
    const keep = Math.max(0, Math.min(buf.length, Math.floor(this.produced * r) - this.dropped));
    this.rest = buf.slice(keep);
    this.dropped += keep;
    return Float32Array.from(out);
  }
}

// ------------------------------------------------------------------ segment

export interface SegmenterOptions {
  sampleRate?: number;
  /** Length of one analysis frame. 20 ms is the usual size for speech detection. */
  frameMs?: number;
  /** Silence after speech that ends a piece (a natural pause). */
  endSilenceMs?: number;
  /** A piece is cut here even mid-sentence, so long monologues still show up in time. */
  maxSegmentMs?: number;
  /** Pieces with less speech than this are dropped (coughs, clicks, "mm"). */
  minSpeechMs?: number;
  /** Audio kept from just before speech starts, so the first syllable isn't clipped. */
  preRollMs?: number;
  /** Loudness below which nothing counts as speech, whatever the room noise. */
  minThreshold?: number;
}

export interface Segment {
  samples: Float32Array; // 16 kHz mono
  speechMs: number;
  /** True when the piece ended because the speaker paused (not because it hit the max length). */
  endedOnPause: boolean;
}

/**
 * Root mean square: square every sample, average them, take the square root.
 * It's the standard measure of loudness for a stretch of audio. Squaring makes
 * negative and positive halves of the wave both count.
 */
export function rms(samples: Float32Array, start = 0, end = samples.length): number {
  let sum = 0;
  for (let i = start; i < end; i++) sum += samples[i] * samples[i];
  return end > start ? Math.sqrt(sum / (end - start)) : 0;
}

/**
 * Voice activity detection (VAD): decides "speech" or "silence" every 20 ms
 * from loudness, and cuts the stream into pieces at natural pauses.
 *
 * The speech threshold adapts to the background: we keep a running estimate
 * of the quietest recent loudness (the "noise floor"), and speech must be
 * clearly louder than that (3×). So a fan or a hum stops counting as talking
 * after a few seconds, but a quiet room still picks up a soft voice.
 *
 * Feed it 16 kHz samples with push(); it returns every finished piece.
 */
export class Segmenter {
  private readonly frame: number;
  private readonly endSilenceFrames: number;
  private readonly maxFrames: number;
  private readonly minSpeechFrames: number;
  private readonly preRollFrames: number;
  private readonly minThreshold: number;
  private readonly frameMs: number;

  private pending = new Float32Array(0); // samples not yet making a full frame
  private preRoll: Float32Array[] = []; // the last few silent frames before speech
  private frames: Float32Array[] = []; // frames of the piece being collected
  private speechFrames = 0;
  private silenceRun = 0;
  private noise = 0.002;

  constructor(opts: SegmenterOptions = {}) {
    const rate = opts.sampleRate ?? TARGET_RATE;
    this.frameMs = opts.frameMs ?? 20;
    this.frame = Math.round((rate * this.frameMs) / 1000);
    const f = (ms: number) => Math.max(1, Math.round(ms / this.frameMs));
    this.endSilenceFrames = f(opts.endSilenceMs ?? 800);
    this.maxFrames = f(opts.maxSegmentMs ?? 15000);
    this.minSpeechFrames = f(opts.minSpeechMs ?? 500);
    this.preRollFrames = f(opts.preRollMs ?? 300);
    this.minThreshold = opts.minThreshold ?? 0.01;
  }

  /** True while a piece of speech is being collected. */
  get inSpeech(): boolean {
    return this.frames.length > 0;
  }

  /** Current speech threshold (exposed for tests and debugging). */
  get threshold(): number {
    return Math.max(this.minThreshold, this.noise * 3);
  }

  push(samples: Float32Array): Segment[] {
    const out: Segment[] = [];
    const buf = new Float32Array(this.pending.length + samples.length);
    buf.set(this.pending, 0);
    buf.set(samples, this.pending.length);

    let i = 0;
    for (; i + this.frame <= buf.length; i += this.frame) {
      const seg = this.onFrame(buf.slice(i, i + this.frame));
      if (seg) out.push(seg);
    }
    this.pending = buf.slice(i);
    return out;
  }

  /** Ends the current piece now (used when you stop listening or press "Answer from audio"). */
  flush(): Segment | null {
    return this.finish(false);
  }

  private onFrame(frame: Float32Array): Segment | null {
    const level = rms(frame);
    const speech = level > this.threshold;
    // Track the background level ("noise floor"). It falls quickly whenever
    // things get quieter (the gaps between words) but rises only slowly
    // (over ~10 s), so short bursts of speech barely move it, while a steady
    // hum or fan is learned within a few seconds and stops counting as speech.
    this.noise += (level - this.noise) * (level < this.noise ? 0.1 : 0.002);

    if (!this.inSpeech) {
      if (!speech) {
        this.preRoll.push(frame);
        if (this.preRoll.length > this.preRollFrames) this.preRoll.shift();
        return null;
      }
      // Speech starts: keep the short stretch just before it too.
      this.frames = [...this.preRoll, frame];
      this.preRoll = [];
      this.speechFrames = 1;
      this.silenceRun = 0;
      return null;
    }

    this.frames.push(frame);
    if (speech) {
      this.speechFrames++;
      this.silenceRun = 0;
    } else {
      this.silenceRun++;
    }

    if (this.silenceRun >= this.endSilenceFrames) return this.finish(true);
    if (this.frames.length >= this.maxFrames) return this.finish(false);
    return null;
  }

  private finish(endedOnPause: boolean): Segment | null {
    if (!this.inSpeech) return null;
    const frames = this.frames;
    const speechFrames = this.speechFrames;
    this.frames = [];
    this.speechFrames = 0;
    this.silenceRun = 0;
    if (speechFrames < this.minSpeechFrames) return null; // too short to be words

    const total = frames.reduce((n, f) => n + f.length, 0);
    const samples = new Float32Array(total);
    let at = 0;
    for (const f of frames) {
      samples.set(f, at);
      at += f.length;
    }
    return { samples, speechMs: speechFrames * this.frameMs, endedOnPause };
  }
}

// ---------------------------------------------------------------------- WAV

/**
 * Wraps mono samples in a WAV file: a 44-byte header that says "16-bit
 * PCM, 1 channel, 16 000 samples per second", followed by the samples as
 * 16-bit whole numbers (-32768…32767) instead of decimals between -1 and 1.
 *
 * Size: 16 000 samples × 2 bytes = 32 KB per second of audio.
 */
export function encodeWav(samples: Float32Array, sampleRate = TARGET_RATE): Buffer {
  const dataBytes = samples.length * 2;
  const b = Buffer.alloc(44 + dataBytes);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(36 + dataBytes, 4); // size of everything after this field
  b.write("WAVE", 8, "ascii");
  b.write("fmt ", 12, "ascii");
  b.writeUInt32LE(16, 16); // size of the format block
  b.writeUInt16LE(1, 20); // 1 = plain PCM, no compression
  b.writeUInt16LE(1, 22); // channels: mono
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * 2, 28); // bytes per second
  b.writeUInt16LE(2, 32); // bytes per sample frame
  b.writeUInt16LE(16, 34); // bits per sample
  b.write("data", 36, "ascii");
  b.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i])); // clip, so loud audio can't wrap around
    b.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), 44 + i * 2);
  }
  return b;
}

/** Joins pieces of audio (used to retry a piece together with the next one). */
export function concatSamples(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// --------------------------------------------------------------- transcript

/**
 * Whisper sometimes "hears" stock phrases in near-silence, because its
 * training data had lots of video captions ending like that. If a whole piece
 * transcribes to only one of these, it's almost certainly not real speech.
 */
const PHANTOMS = [
  /^thank you( (so|very) much)?( for watching)?[.!]*$/i,
  /^thanks for watching[.!]*$/i,
  /^(you|bye|okay|so|um|uh)[.!]*$/i,
  /^subtitles? by .*$/i,
  /^[.\s…]*$/,
];

/** Trims a transcription and returns "" for empty text or a known phantom phrase. */
export function cleanTranscript(text: string): string {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (PHANTOMS.some((re) => re.test(t))) return "";
  return t;
}

/**
 * Rough guess whether the interviewer just asked something, used only by the
 * optional auto-answer. A question mark is the strongest signal (Whisper adds
 * punctuation); otherwise look at how the last sentence starts.
 */
export function looksLikeQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/\?\s*$/.test(t)) return true;
  const last = t.split(/(?<=[.!?])\s+/).pop()!.toLowerCase();
  return /^(so,? )?(what|why|how|when|where|which|who|can you|could you|would you|tell me|walk me|describe|explain|talk me|give me|have you|do you|did you|are you)\b/.test(
    last
  );
}
