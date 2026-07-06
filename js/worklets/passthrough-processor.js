class PassthroughProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // PCM gonderimi acik mi? (main thread'den kontrol edilir)
    this.sendPcm = false;

    // Port uzerinden mesaj al
    this.port.onmessage = (e) => {
      try {
        if (e.data.command === 'enablePcm') {
          this.sendPcm = true;
        } else if (e.data.command === 'disablePcm') {
          this.sendPcm = false;
        }
      } catch (err) {
        console.error('[Worklet] Port message error:', err);
        this.port.postMessage({ error: err.message || 'Unknown worklet error' });
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];

    if (!input || input.length === 0) return true;

    // Passthrough: input -> output
    for (let channel = 0; channel < input.length; channel++) {
      const inputChannel = input[channel];
      const outputChannel = output[channel];
      if (!inputChannel || !outputChannel) continue;

      for (let i = 0; i < inputChannel.length; i++) {
        outputChannel[i] = inputChannel[i];
      }
    }

    // Encoder modu: PCM data'yi main thread'e gonder
    if (this.sendPcm && input[0]) {
      const pcmChannels = input.map(channelData => new Float32Array(channelData));
      const transferList = pcmChannels.map(channelData => channelData.buffer);
      this.port.postMessage({ pcmChannels }, transferList);
    }

    return true;
  }
}

registerProcessor('passthrough-processor', PassthroughProcessor);
