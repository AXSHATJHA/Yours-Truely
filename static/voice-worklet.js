// Runs on the browser's audio thread (an "AudioWorklet"), separate from the
// page, so audio never stutters when the page is busy.
//
// The audio engine calls process() with 128 samples at a time per channel.
// We mix the channels down to mono (average of left and right), collect
// 4096 samples (about 85 ms at 48 kHz), and post them to the page, which
// forwards them to the main process. Sending every 128-sample block
// separately would mean ~375 messages a second for no benefit.
class VoiceTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(4096);
    this.n = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input.length) {
      const channels = input.length;
      const len = input[0].length;
      for (let i = 0; i < len; i++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) sum += input[c][i];
        this.buf[this.n++] = sum / channels;
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf);
          this.buf = new Float32Array(4096);
          this.n = 0;
        }
      }
    }
    return true; // keep running
  }
}

registerProcessor("voice-tap", VoiceTap);
