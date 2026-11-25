// Tests for the voice feature's audio helpers (src/voice-audio.ts) and the
// Whisper hint limit (src/transcribe.ts). They use generated sound: a sine
// wave stands in for a voice, zeros for silence.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Resampler, Segmenter, encodeWav, concatSamples, cleanTranscript, looksLikeQuestion, rms } = require("../dist/voice-audio.js");
const { limitPrompt } = require("../dist/transcribe.js");

const RATE = 16000;
const tone = (seconds, amp = 0.3, freq = 220, rate = RATE) =>
  Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / rate));
const silence = (seconds, rate = RATE) => new Float32Array(Math.round(seconds * rate));

// Feed audio in uneven blocks, the way the capture window delivers it.
function feed(seg, audio, block = 1234) {
  const out = [];
  for (let i = 0; i < audio.length; i += block) out.push(...seg.push(audio.subarray(i, i + block)));
  return out;
}

// ---------------------------------------------------------------- WAV

test("WAV header describes 16 kHz mono 16-bit PCM", () => {
  const wav = encodeWav(new Float32Array(160));
  assert.equal(wav.length, 44 + 320);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(4), 36 + 320);
  assert.equal(wav.toString("ascii", 8, 16), "WAVEfmt ");
  assert.equal(wav.readUInt16LE(20), 1); // PCM
  assert.equal(wav.readUInt16LE(22), 1); // mono
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt32LE(28), 32000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.toString("ascii", 36, 40), "data");
  assert.equal(wav.readUInt32LE(40), 320);
});

test("WAV samples are scaled and clipped", () => {
  const wav = encodeWav(Float32Array.from([0, 1, -1, 2, -2, 0.5]));
  const at = (i) => wav.readInt16LE(44 + i * 2);
  assert.deepEqual([0, 1, 2, 3, 4].map(at), [0, 32767, -32768, 32767, -32768]);
  assert.equal(at(5), 16384);
});

// ---------------------------------------------------------- resampling

test("48 kHz becomes 16 kHz, a third of the samples, across uneven blocks", () => {
  const r = new Resampler(48000);
  const input = tone(1, 0.5, 440, 48000);
  const parts = [];
  for (let i = 0; i < input.length; i += 1000) parts.push(r.push(input.subarray(i, i + 1000)));
  const out = concatSamples(parts);
  assert.ok(Math.abs(out.length - 16000) <= 1, `got ${out.length}`);
  // A 440 Hz voice-range tone keeps its loudness (RMS of a sine = amp / √2).
  assert.ok(Math.abs(rms(out) - 0.5 / Math.SQRT2) < 0.01);
});

test("a non-whole ratio (44.1 kHz) gives the same result in blocks as in one go", () => {
  const input = tone(0.5, 0.4, 300, 44100);
  const whole = new Resampler(44100).push(input);
  const r = new Resampler(44100);
  const pieces = concatSamples([r.push(input.subarray(0, 777)), r.push(input.subarray(777, 5000)), r.push(input.subarray(5000))]);
  // Rounding in the fractional position can move the very last sample by one.
  assert.ok(Math.abs(pieces.length - whole.length) <= 1);
  const n = Math.min(pieces.length, whole.length);
  for (let i = 0; i < n; i++) assert.ok(Math.abs(pieces[i] - whole[i]) < 1e-6);
});

test("very high pitches are smoothed away by the averaging", () => {
  // 16 kHz at 48 kHz: exactly 3 samples per cycle, so averaging cancels it.
  const out = new Resampler(48000).push(tone(0.2, 0.5, 16000, 48000));
  assert.ok(rms(out) < 0.01);
});

// ------------------------------------------------------------ segmenter

test("speech between pauses becomes one piece, ended by the pause", () => {
  const seg = new Segmenter();
  const out = feed(seg, concatSamples([silence(1), tone(2), silence(1.2)]));
  assert.equal(out.length, 1);
  assert.equal(out[0].endedOnPause, true);
  assert.ok(Math.abs(out[0].speechMs - 2000) <= 40, `speech ${out[0].speechMs} ms`);
  // 0.3 s kept from before the speech + 2 s speech + 0.8 s pause that ended it.
  assert.ok(Math.abs(out[0].samples.length / RATE - 3.1) < 0.05, `length ${out[0].samples.length / RATE} s`);
  assert.equal(seg.inSpeech, false);
});

test("two sentences with a pause between become two pieces", () => {
  const out = feed(new Segmenter(), concatSamples([tone(1.5), silence(1), tone(1), silence(1)]));
  assert.equal(out.length, 2);
});

test("a short pause inside a sentence does not cut it", () => {
  const out = feed(new Segmenter(), concatSamples([tone(1), silence(0.4), tone(1), silence(1)]));
  assert.equal(out.length, 1);
});

test("clicks and coughs shorter than half a second are dropped", () => {
  const out = feed(new Segmenter(), concatSamples([silence(0.5), tone(0.2), silence(1.5)]));
  assert.equal(out.length, 0);
});

test("silence and very quiet hiss produce nothing", () => {
  const hiss = Float32Array.from({ length: RATE * 3 }, () => (Math.random() * 2 - 1) * 0.005);
  assert.equal(feed(new Segmenter(), hiss).length, 0);
});

test("a long monologue is cut at 15 s, and flush() returns the rest", () => {
  // Speech-like: 0.4 s of sound, 0.15 s gap (between words), for 20 s. The gaps are
  // too short to end a piece, so only the 15 s limit cuts it.
  const words = [];
  for (let t = 0; t < 20; t += 0.55) words.push(tone(0.4), silence(0.15));
  const seg = new Segmenter();
  const out = feed(seg, concatSamples(words));
  assert.equal(out.length, 1);
  assert.equal(out[0].endedOnPause, false);
  assert.ok(Math.abs(out[0].samples.length / RATE - 15) < 0.05);
  const rest = seg.flush();
  assert.ok(rest && rest.samples.length / RATE > 4);
});

test("flush() hands over speech in progress (used by Answer from audio)", () => {
  const seg = new Segmenter();
  assert.equal(feed(seg, tone(1.5)).length, 0);
  assert.equal(seg.inSpeech, true);
  const piece = seg.flush();
  assert.ok(piece && piece.samples.length > 0);
  assert.equal(piece.endedOnPause, false);
  assert.equal(seg.flush(), null);
});

test("a steady hum stops counting as speech after a few seconds", () => {
  const seg = new Segmenter();
  const out = feed(seg, tone(30, 0.03, 50)); // 50 Hz mains hum, louder than the minimum threshold
  // It may produce one early piece while the floor is learned, then nothing more.
  assert.ok(out.length <= 1, `got ${out.length} pieces`);
  assert.equal(seg.inSpeech, false);
  // Real speech, clearly louder than the hum, is still picked up afterwards.
  const after = feed(seg, concatSamples([tone(1.5, 0.3, 220), tone(1.2, 0.03, 50)]));
  assert.equal(after.length, 1);
});

// ------------------------------------------------------------ transcript

test("Whisper's phantom phrases on silence are dropped", () => {
  for (const t of ["Thank you.", "thanks for watching!", " you ", "...", "", "Thank you so much for watching."]) {
    assert.equal(cleanTranscript(t), "", JSON.stringify(t));
  }
  assert.equal(cleanTranscript("  Thank you for   joining us today. "), "Thank you for joining us today.");
});

test("questions are recognised for auto-answer", () => {
  assert.equal(looksLikeQuestion("What is a hash map?"), true);
  assert.equal(looksLikeQuestion("Great. Tell me about a time you failed"), true);
  assert.equal(looksLikeQuestion("So walk me through your last project."), true);
  assert.equal(looksLikeQuestion("That sounds good. Let's move on."), false);
  assert.equal(looksLikeQuestion(""), false);
});

test("the Whisper hint keeps the most recent words within the limit", () => {
  const long = "a ".repeat(500) + "the end";
  const p = limitPrompt(long);
  assert.ok(p.length <= 600);
  assert.ok(p.endsWith("the end"));
  assert.equal(limitPrompt("  short   hint "), "short hint");
});
