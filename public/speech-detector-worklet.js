class PNGCallsSpeechDetector extends AudioWorkletProcessor {
  constructor() {
    super();
    this.speaking = false;
    this.silentBlocks = 0;
    this.reportBlocks = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel?.length) return true;
    let energy = 0;
    for (const sample of channel) energy += sample * sample;
    const level = Math.sqrt(energy / channel.length);
    const detected = level > 0.035;
    this.silentBlocks = detected ? 0 : this.silentBlocks + 1;
    const nextSpeaking = detected || (this.speaking && this.silentBlocks < 300);
    this.reportBlocks += 1;
    if (nextSpeaking !== this.speaking || this.reportBlocks >= 30) {
      this.speaking = nextSpeaking;
      this.reportBlocks = 0;
      this.port.postMessage({ speaking: this.speaking, level });
    }
    return true;
  }
}

registerProcessor("pngcalls-speech-detector", PNGCallsSpeechDetector);
