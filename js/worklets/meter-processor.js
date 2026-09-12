// A silent measurement sidechain. No PCM crosses the port and encoder ordering
// is independent of this node. One unacknowledged packet bounds the queue when
// the page is busy; audio-thread peak evidence keeps accumulating meanwhile.
class MeterProcessor extends AudioWorkletProcessor {
  constructor({ processorOptions }) {
    super();
    const { intervalMs, clipThreshold, highThreshold } = processorOptions;
    this.intervalFrames = Math.max(1, Math.round(sampleRate * intervalMs / 1000));
    this.clipThreshold = clipThreshold;
    this.highThreshold = highThreshold;
    this.frames = 0;
    this.sum = 0;
    this.sumSquares = 0;
    this.sampleCount = 0;
    this.bucketPeak = 0;
    this.peak = 0;
    this.peakTime = -Infinity;
    this.clipTime = -Infinity;
    this.highTime = -Infinity;
    this.pending = false;
    this.stopped = false;
    this.port.onmessage = ({ data }) => {
      if (data === 'ack') this.pending = false;
      if (data === 'stop') this.stopped = true;
    };
  }

  process(inputs, outputs) {
    if (this.stopped) return false;
    // Explicit mono downmix matches AnalyserNode time-domain monitoring.
    const samples = inputs[0]?.[0];
    const length = samples?.length ?? outputs[0][0].length;
    let blockPeak = 0, blockSum = 0;
    for (let i = 0; i < length; i++) {
      const value = samples?.[i] ?? 0;
      blockSum += value * value;
      blockPeak = Math.max(blockPeak, Math.abs(value));
    }
    const time = currentTime + length / sampleRate;
    this.sum += blockSum;
    this.sumSquares += blockSum;
    this.sampleCount += length;
    if (blockPeak >= this.peak) { this.peak = blockPeak; this.peakTime = time; }
    if (blockPeak >= this.clipThreshold) this.clipTime = time;
    if (blockPeak >= this.highThreshold) this.highTime = time;
    this.bucketPeak = Math.max(this.bucketPeak, blockPeak);
    this.frames += length;
    if (this.frames >= this.intervalFrames) {
      if (!this.pending) {
        this.port.postMessage({
          rms: Math.sqrt(this.sum / this.frames), livePeak: this.bucketPeak,
          sumSquares: this.sumSquares, sampleCount: this.sampleCount,
          peak: this.peak, peakTime: this.peakTime, time,
          clipTime: this.clipTime, highTime: this.highTime
        });
        this.pending = true;
        this.peak = 0;
        this.peakTime = -Infinity;
        this.sumSquares = 0;
        this.sampleCount = 0;
      }
      // RMS/live peak always describe the latest small bucket, never a long
      // average of the time the main thread spent blocked.
      this.frames = 0;
      this.sum = 0;
      this.bucketPeak = 0;
    }
    // Output is left at its default zero: this must never enable live listening.
    return true;
  }
}

registerProcessor('meter-processor', MeterProcessor);
