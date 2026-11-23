// The hidden voice-capture window (static/voice.html). It is never shown.
//
// The main process calls window.voiceCapture.start() / stop(). start() opens
// two kinds of audio:
//  - "them": the meeting. getDisplayMedia() is the browser's screen-share
//    function; the main process answers it with loopback audio, meaning a copy
//    of everything Windows is playing.
//  - "me" (optional): your microphone, through getUserMedia().
// Each stream goes through a small AudioWorklet (static/voice-worklet.js) that
// hands us raw samples, which we forward to the main process unchanged.
// All the thinking (resampling, cutting at pauses, transcription) happens in
// the main process, so this page stays tiny.
(() => {
  type Who = "them" | "me";
  type Stage = "setup" | "system" | "mic";

  let ctx: AudioContext | null = null;
  let streams: MediaStream[] = [];
  const nodes: AudioNode[] = []; // kept referenced so they aren't garbage-collected

  function fail(err: unknown, stage: Stage) {
    stop();
    const e = err as { name?: string; message?: string };
    return { ok: false, error: { name: e?.name || "Error", message: e?.message || String(err), stage } };
  }

  function tap(stream: MediaStream, who: Who) {
    if (!ctx) return;
    const context = ctx;
    const src = context.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(context, "voice-tap", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    node.port.onmessage = (e: MessageEvent<Float32Array>) => window.voice.sendAudio(who, e.data, context.sampleRate);
    // The audio graph only runs nodes that lead to the speakers, so connect it
    // through a volume of 0: it runs, but you hear nothing extra.
    const mute = context.createGain();
    mute.gain.value = 0;
    src.connect(node);
    node.connect(mute);
    mute.connect(context.destination);
    nodes.push(src, node, mute);
    for (const track of stream.getAudioTracks()) {
      track.addEventListener("ended", () =>
        window.voice.captureEnded(who === "me" ? "The microphone stopped." : "The meeting audio stopped (the output device may have changed).")
      );
    }
  }

  async function start(opts: { mic: boolean }) {
    try {
      // The device's own rate (usually 48 kHz). The main process converts to 16 kHz.
      ctx = new AudioContext();
      await ctx.audioWorklet.addModule("voice-worklet.js");
    } catch (err) {
      return fail(err, "setup");
    }

    let system: MediaStream;
    try {
      // Chromium always captures a video track with screen sharing. We keep it
      // (stopping it can end the audio too on some systems) but ask for the
      // smallest, slowest version and switch it off, so it costs almost nothing.
      system = await navigator.mediaDevices.getDisplayMedia({
        audio: true,
        video: { width: 320, height: 180, frameRate: 1 },
      });
    } catch (err) {
      return fail(err, "system");
    }
    streams.push(system);
    for (const t of system.getVideoTracks()) t.enabled = false;
    if (!system.getAudioTracks().length) {
      return fail({ name: "NoAudio", message: "No audio track" }, "system");
    }
    tap(system, "them");

    if (opts.mic) {
      try {
        const mic = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        streams.push(mic);
        tap(mic, "me");
      } catch (err) {
        return fail(err, "mic");
      }
    }
    return { ok: true };
  }

  function stop() {
    for (const s of streams) for (const t of s.getTracks()) t.stop();
    streams = [];
    nodes.length = 0;
    const c = ctx;
    ctx = null;
    c?.close().catch(() => {});
  }

  window.voiceCapture = { start, stop };
})();
