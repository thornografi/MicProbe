// Known transformation for the capture-points integration test only.
class HalfGain extends AudioWorkletProcessor {
  constructor() {super();this.frames=0;}
  process(inputs,outputs) {
    const source=inputs[0]?.[0],destination=outputs[0][0];
    for(let i=0;i<destination.length;i++)destination[i]=(source?.[i]??0)*0.5;
    this.frames+=destination.length;
    if(this.frames%48000<destination.length)this.port.postMessage(this.frames);
    return true;
  }
}
registerProcessor('lab-half-gain',HalfGain);
