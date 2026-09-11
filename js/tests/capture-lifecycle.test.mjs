import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import Recorder from '../modules/Recorder.js';
import recordingController from '../controllers/RecordingController.js';
import eventBus from '../modules/EventBus.js';
import { EVENTS, RECORDING } from '../modules/constants.js';
import { createOpusWorker, OpusRecorderWrapper } from '../modules/OpusWorkerHelper.js';
import WorkletPipeline from '../pipelines/WorkletPipeline.js';
import ScriptProcessorPipeline from '../pipelines/ScriptProcessorPipeline.js';
import { createWavBlob } from '../modules/utils/wav.js';

// Browser boundaries are faked; capture, lifecycle, pipeline, encoder wrapper,
// WAV conversion, and AudioWorklet processor all run their production code.
const wavWorkerSource = readFileSync(new URL('../workers/wav-worker.js', import.meta.url), 'utf8');
const workletSource = readFileSync(new URL('../worklets/passthrough-processor.js', import.meta.url), 'utf8');
let clock = 0;
let contextFailure = false;
let workletFailure = false;
let stream;
let workers = [];
let deferEncoding = false;
let pendingEncoding = [];

class Track extends EventTarget {
  constructor(channels = 1) { super(); this.channels = channels; this.readyState = 'live'; this.stopCount = 0; this.label = 'Test microphone'; }
  stop() { this.stopCount++; this.readyState = 'ended'; }
  end() { this.readyState = 'ended'; this.dispatchEvent(new Event('ended')); }
  getSettings() { return { sampleRate: 48000, channelCount: this.channels, noiseSuppression: true }; }
  getConstraints() { return {}; }
}
function makeStream(channels = 1) {
  const track = new Track(channels);
  return { id: 'stream', track, getTracks: () => [track], getAudioTracks: () => [track] };
}
class AudioNode {
  constructor() { this.channelCount = 1; this.gain = { value: 1 }; this.delayTime = { value: 0 }; }
  connect() {}
  disconnect() { this.disconnected = true; }
}
class AudioContext {
  constructor() {
    if (contextFailure) throw new Error('AudioContext setup failed');
    this.sampleRate = 48000; this.state = 'running'; this.destination = new AudioNode();
    this.audioWorklet = { addModule: async () => { if (workletFailure) throw new Error('Worklet setup failed'); } };
  }
  createMediaStreamSource() { return new AudioNode(); }
  createMediaStreamDestination() { return Object.assign(new AudioNode(), { stream: makeStream() }); }
  createAnalyser() { return new AudioNode(); }
  createGain() { return new AudioNode(); }
  createDelay() { return new AudioNode(); }
  createScriptProcessor() { return new AudioNode(); }
  async close() { this.state = 'closed'; }
}
class AudioWorkletNode extends AudioNode {
  constructor() {
    super();
    const mainPort = { onmessage: null };
    const processorPort = {
      onmessage: null,
      postMessage: data => queueMicrotask(() => mainPort.onmessage?.({ data }))
    };
    mainPort.postMessage = data => queueMicrotask(() => processorPort.onmessage({ data }));
    let Processor;
    vm.runInNewContext(workletSource, {
      AudioWorkletProcessor: class { constructor() { this.port = processorPort; } },
      registerProcessor: (_, value) => { Processor = value; },
      Float32Array, console
    });
    this.processor = new Processor();
    this.port = mainPort;
  }
  input(channels) { this.processor.process([channels], [channels.map(channel => new Float32Array(channel.length))]); }
}
class Worker {
  constructor(url) { this.url = String(url); this.messages = []; this.terminated = false; workers.push(this); }
  postMessage(data) {
    this.messages.push(data);
    if (data.command === 'init') queueMicrotask(() => this.onmessage?.({ data: { message: 'ready', preSkip: 336 } }));
    if (data.command === 'done' || data.type === 'createWav') {
      const complete = () => {
        if (data.type === 'createWav') {
          const self = { postMessage: result => this.onmessage?.({ data: result }) };
          vm.runInNewContext(wavWorkerSource, { self, Float32Array, Int16Array, ArrayBuffer, DataView });
          self.onmessage({ data });
        } else {
          // Fake codec packets with real Ogg framing; decoder/tail preservation
          // is tested separately against the actual WASM worker in the browser.
          const init = this.messages.find(message => message.command === 'init');
          const packetCount = Math.ceil((data.sampleCount * 48000 / init.originalSampleRate + 336) / 960);
          const muxer = new OpusRecorderWrapper();
          for (let packet = 0; packet < packetCount; packet += 40) {
            const count = Math.min(40, packetCount - packet);
            const page = muxer._createOggPage(Array.from({ length: count }, () => new Uint8Array([0xf8, 0xff, 0xfe])),
              BigInt((packet + count) * 960), false, false, packet / 40);
            void this.onmessage?.({ data: { message: 'page', page } });
          }
          void this.onmessage?.({ data: { message: 'done' } });
        }
      };
      if (deferEncoding) pendingEncoding.push(complete);
      else queueMicrotask(complete);
    }
  }
  terminate() { this.terminated = true; }
}
class MediaRecorder {
  static isTypeSupported() { return true; }
  constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; this.stopCount = 0; }
  start() { this.state = 'recording'; }
  stop() {
    this.state = 'inactive'; this.stopCount++;
    queueMicrotask(() => {
      this.ondataavailable?.({ data: new Blob(['captured audio']) });
      this.onstop?.();
    });
  }
}
function reset(channels = 1) {
  clock = 0; contextFailure = false; workletFailure = false;
  workers = []; deferEncoding = false; pendingEncoding = []; stream = makeStream(channels);
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => clock } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => stream } } });
  globalThis.window = { AudioContext, AudioWorkletNode };
  globalThis.AudioWorkletNode = AudioWorkletNode;
  globalThis.Worker = Worker;
  globalThis.MediaRecorder = MediaRecorder;
}
async function drain() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function collect(event) { const values = []; const off = eventBus.on(event, data => values.push(data)); return { values, off }; }

test('Recorder releases microphone after AudioContext and Worklet setup failures', async () => {
  for (const failWorklet of [false, true]) {
    reset(); contextFailure = !failWorklet; workletFailure = failWorklet;
    const recorder = new Recorder();
    const stopped = collect(EVENTS.STREAM_STOPPED);
    await assert.rejects(recorder.start({}, 'worklet', 'pcm-wav'), /setup failed/);
    assert.equal(stream.track.stopCount, 1);
    assert.equal(recorder.getStream(), null);
    assert.equal(recorder.audioContext, null);
    assert.equal(recorder.pipelineStrategy, null);
    assert.equal(stopped.values.length, 0, 'unpublished streams do not emit an unmatched stop');
    stopped.off();
  }
});

test('Opus Stop is shared; input and metrics stop before encoding and duration excludes finalization', async () => {
  reset(2);
  const recorder = new Recorder();
  const completed = collect(EVENTS.RECORDING_COMPLETED);
  const capture = collect(EVENTS.RECORDING_CAPTURE_STOPPED);
  await recorder.start({ channelCount: 2 }, 'worklet', 'wasm-opus');
  await drain();
  recorder.pipelineStrategy.nodes.worklet.input([new Float32Array(336000).fill(0.2), new Float32Array(336000).fill(-0.3)]);
  await drain();
  deferEncoding = true; clock = 7000;
  const first = recorder.stop(); const second = recorder.stop();
  assert.equal(first, second);
  await drain();
  assert.equal(stream.track.readyState, 'ended');
  assert.equal(capture.values.length, 1);
  assert.equal(completed.values.length, 0);
  assert.equal(workers[0].messages.filter(message => message.command === 'done').length, 1);
  clock = 10000; pendingEncoding.splice(0).forEach(finish => finish());
  await first;
  assert.equal(completed.values.length, 1);
  assert.equal(completed.values[0].durationMs, 7000);
  assert.equal(completed.values[0].sampleCount, 336000);
  assert.equal(completed.values[0].channels, 2);
  assert.equal(completed.values[0].requestedBitrate, null);
  assert.equal(stream.track.stopCount, 1);
  completed.off(); capture.off();
});

test('WAV retains stereo samples, counts frames per channel and derives stereo bitrate', async () => {
  reset(2);
  const recorder = new Recorder(); const completed = collect(EVENTS.RECORDING_COMPLETED);
  await recorder.start({ channelCount: 2 }, 'worklet', 'pcm-wav'); await drain();
  recorder.pipelineStrategy.nodes.worklet.input([new Float32Array([0.25, 0.5]), new Float32Array([-0.25, -0.5])]);
  // Stop before queued PCM arrives: the port acknowledgement must drain those frames.
  await recorder.stop();
  const result = completed.values[0];
  assert.equal(result.sampleCount, 2);
  assert.equal(result.durationMs, 2 / 48000 * 1000);
  assert.equal(result.requestedBitrate, 1536000);
  const wav = new DataView(await result.blob.arrayBuffer());
  assert.equal(wav.getUint16(22, true), 2);
  assert.equal(wav.getUint32(40, true), 8);
  assert.deepEqual([44, 46, 48, 50].map(offset => wav.getInt16(offset, true)), [8191, -8192, 16383, -16384]);
  completed.off();
});

test('Encoder failures are reported once and release resources despite repeated Stop', async () => {
  reset(); const recorder = new Recorder();
  await recorder.start({}, 'worklet', 'pcm-wav');
  const failed = collect(EVENTS.RECORDING_FAILED); const completed = collect(EVENTS.RECORDING_COMPLETED);
  const context = recorder.audioContext;
  recorder.pipelineStrategy.finishPcmWavEncoding = async () => { throw new Error('encoding failed'); };
  const first = recorder.stop(); assert.equal(first, recorder.stop());
  await assert.rejects(first, /encoding failed/);
  assert.equal(failed.values.length, 1); assert.equal(completed.values.length, 0);
  assert.equal(stream.track.stopCount, 1); assert.equal(context.state, 'closed');
  assert.equal(recorder.getIsRecording(), false);
  failed.off(); completed.off();
});

test('Device ended finalizes a recording and resets controller state and timer', async () => {
  reset(); const recorder = new Recorder(); let mode = null; let preparing = false; let timerStopped = 0;
  recordingController.setDependencies({ recorder, getCurrentMode: () => mode, setCurrentMode: value => { mode = value; },
    getIsPreparing: () => preparing, setIsPreparing: value => { preparing = value; },
    uiStateManager: { updateButtonStates() {}, startTimer() {}, stopTimer() { timerStopped++; } },
    getPipeline: () => 'worklet', getEncoder: () => 'pcm-wav', isWebAudioEnabled: () => true });
  const completed = collect(EVENTS.RECORDING_COMPLETED);
  await recordingController.start(); await drain();
  recorder.pipelineStrategy.nodes.worklet.input([new Float32Array(128).fill(0.2)]);
  stream.track.end(); await drain(); await recorder.stop();
  assert.equal(completed.values.length, 1);
  assert.equal(completed.values[0].stopReason, 'device-ended');
  assert.equal(mode, null); assert.equal(preparing, false); assert.ok(timerStopped > 0);
  completed.off();
});

test('MediaRecorder stop and spontaneous end use the same finalization and close direct analyser context', async () => {
  for (const spontaneous of [false, true]) {
    reset(); const recorder = new Recorder(); const completed = collect(EVENTS.RECORDING_COMPLETED);
    await recorder.start({}, 'direct', 'mediarecorder');
    const context = recorder.audioContext; const media = recorder.mediaRecorder;
    clock = 7000;
    if (spontaneous) { media.stop(); await drain(); }
    await recorder.stop();
    assert.equal(media.stopCount, 1);
    assert.equal(completed.values.length, 1);
    assert.equal(completed.values[0].durationMs, 7000);
    assert.equal(context.state, 'closed'); assert.equal(recorder.getIsRecording(), false);
    completed.off();
  }
});

test('MediaRecorder synchronous stop failure reports failure and still closes microphone', async () => {
  reset(); const recorder = new Recorder(); const failed = collect(EVENTS.RECORDING_FAILED);
  await recorder.start({}, 'direct', 'mediarecorder');
  recorder.mediaRecorder.stop = () => { throw new Error('stop rejected'); };
  await assert.rejects(recorder.stop(), /stop rejected/);
  assert.equal(stream.track.stopCount, 1); assert.equal(recorder.audioContext, null);
  assert.equal(failed.values.length, 1); failed.off();
});

test('Raw PCM memory limit explicitly finishes retained audio and informs the user', async () => {
  reset(); const recorder = new Recorder(); const completed = collect(EVENTS.RECORDING_COMPLETED); const messages = collect(EVENTS.UI_MESSAGE);
  await recorder.start({}, 'worklet', 'pcm-wav'); await drain();
  const pipeline = recorder.pipelineStrategy;
  pipeline._pcmBytes = RECORDING.MAX_PCM_BYTES - 128 * 4;
  pipeline.nodes.worklet.input([new Float32Array(128).fill(0.2)]);
  pipeline.nodes.worklet.input([new Float32Array(128).fill(0.3)]);
  await drain(); await recorder.stop();
  assert.equal(completed.values.length, 1);
  assert.equal(completed.values[0].sampleCount, 128);
  assert.equal(completed.values[0].stopReason, 'memory-limit');
  assert.ok(messages.values.some(message => message.message.includes('memory limit')));
  completed.off(); messages.off();
});

test('ScriptProcessor preserves both encoder channels and passthrough samples', async () => {
  reset(); const pipeline = new ScriptProcessorPipeline(new AudioContext(), new AudioNode(), null);
  await pipeline.setup({ channels: 2 }); pipeline.startCapture();
  const samples = [new Float32Array([0.2, 0.3]), new Float32Array([-0.4, -0.5])];
  const outputs = samples.map(value => new Float32Array(value.length));
  pipeline.nodes.processor.onaudioprocess({ inputBuffer: { getChannelData: channel => samples[channel] }, outputBuffer: { getChannelData: channel => outputs[channel] } });
  const encoded = workers[0].messages.find(message => message.command === 'encode');
  assert.deepEqual(encoded.buffers, samples); assert.deepEqual(outputs, samples);
  assert.equal(pipeline.capturedFrames, 2); await pipeline.cleanup();
});

test('Opus wrapper validates channel contract and shares finalization promise', async () => {
  reset(); const wrapper = await createOpusWorker({ sampleRate: 44100, channels: 2 });
  assert.throws(() => wrapper.encode(new Float32Array(128)), /channel count/);
  wrapper.encode([new Float32Array(441), new Float32Array(441)]);
  const first = wrapper.finish(); assert.equal(first, wrapper.finish());
  assert.throws(() => wrapper.encode([new Float32Array(1), new Float32Array(1)]), /finished or finishing/);
  const result = await first;
  assert.equal(result.sampleCount, 441); assert.equal(result.duration, 0.01); wrapper.terminate();
});


test('A pending microphone request can be cancelled without starting or leaking its eventual stream', async () => {
  reset(); const recorder = new Recorder(); let grant;
  navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { grant = resolve; });
  const started = collect(EVENTS.RECORDING_STARTED);
  const start = recorder.start({}, 'worklet', 'pcm-wav');
  const stopped = recorder.stop(); grant(stream);
  await assert.rejects(start, /cancelled/); await stopped;
  assert.equal(stream.track.stopCount, 1); assert.equal(started.values.length, 0);
  started.off();
});

test('WASM initialization failure terminates its worker', async () => {
  reset(); globalThis.Worker = class extends Worker { postMessage() { throw new Error('init transport failed'); } };
  await assert.rejects(createOpusWorker({ channels: 1 }), /init transport failed/);
  assert.equal(workers.length, 1); assert.equal(workers[0].terminated, true);
});

test('controller Cancel releases preparation before permission arrives and a late stream cannot affect the retry', async () => {
  reset();
  const recorder = new Recorder(); const oldStream = stream;
  let grant, mode = null, preparing = false, timers = 0;
  navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { grant = resolve; });
  recordingController.setDependencies({ recorder, getCurrentMode: () => mode, setCurrentMode: value => { mode = value; },
    getIsPreparing: () => preparing, setIsPreparing: value => { preparing = value; },
    uiStateManager: { updateButtonStates() {}, startTimer() { timers++; }, stopTimer() {} },
    getPipeline: () => 'worklet', getEncoder: () => 'pcm-wav', isWebAudioEnabled: () => true });
  const messages = collect(EVENTS.UI_MESSAGE);
  const first = recordingController.toggle();
  assert.equal(preparing, true);
  await recordingController.toggle(); await first;
  assert.equal(mode, null); assert.equal(preparing, false); assert.equal(timers, 0);
  assert.equal(recorder.getIsStopping(), false);
  const replacement = makeStream();
  navigator.mediaDevices.getUserMedia = async () => replacement;
  await recordingController.toggle();
  grant(oldStream); await drain();
  assert.equal(oldStream.track.readyState, 'ended');
  assert.equal(recorder.stream, replacement); assert.equal(replacement.track.readyState, 'live');
  assert.equal(mode, 'recording'); assert.equal(timers, 1);
  assert.deepEqual(messages.values, []);
  await recordingController.toggle(); messages.off();
});

test('quota refusal and cancelled admission leave the previous player and microphone untouched', async () => {
  let mode = null, preparing = false, started = 0, paused = 0, release, resolve;
  recordingController.setDependencies({ getCurrentMode: () => mode, setCurrentMode: value => { mode = value; },
    getIsPreparing: () => preparing, setIsPreparing: value => { preparing = value; },
    createRunSnapshot: () => ({ runId: 'quota-controller-run' }),
    recorder: { start: async () => { started++; }, stop: async () => {} }, player: { pause: () => { paused++; } },
    testAccess: { begin: async () => false, release: async id => { release = id; } } });
  await recordingController.start();
  assert.equal(mode, null); assert.equal(started, 0); assert.equal(paused, 0);
  recordingController.deps.testAccess.begin = () => new Promise(done => { resolve = done; });
  const starting = recordingController.start();
  await recordingController.stop();
  resolve(true); await starting;
  assert.equal(started, 0); assert.equal(paused, 0); assert.equal(release, 'quota-controller-run');
  assert.equal(mode, null);
  recordingController.setDependencies({ testAccess: null, createRunSnapshot: undefined, player: null });
});

test('a late warmup closes its own context without replacing an active recording context', async () => {
  reset(); let release, warmContext;
  window.AudioContext = class extends AudioContext {
    constructor() {
      super();
      if (!warmContext) {
        warmContext = this; this.state = 'suspended';
        this.resume = () => new Promise(resolve => { release = resolve; });
      }
    }
  };
  const recorder = new Recorder();
  const warming = recorder.warmup();
  await recorder.start({}, 'worklet', 'pcm-wav');
  const activeContext = recorder.audioContext;
  release(); await warming;
  assert.equal(warmContext.state, 'closed');
  assert.equal(recorder.audioContext, activeContext);
  assert.equal(activeContext.state, 'running');
  assert.equal(recorder.isRecording, true);
  recorder.pipelineStrategy.nodes.worklet.input([new Float32Array(128).fill(0.2)]);
  await recorder.stop();
});

test('preparation cancellation releases a suspended context, delayed worklet or initializing Opus worker', async () => {
  for (const stage of ['context', 'worklet', 'opus']) {
    reset(); let release, pendingContext;
    window.AudioContext = class extends AudioContext {
      constructor() {
        super(); pendingContext = this;
        if (stage === 'context') { this.state = 'suspended'; this.resume = () => new Promise(resolve => { release = resolve; }); }
        if (stage === 'worklet') this.audioWorklet.addModule = () => new Promise(resolve => { release = resolve; });
      }
    };
    if (stage === 'opus') globalThis.Worker = class extends Worker {
      postMessage(data) {
        if (data.command === 'init') release = () => this.onmessage?.({ data: { message: 'ready' } });
        else super.postMessage(data);
      }
    };
    const recorder = new Recorder();
    const started = recorder.start({}, 'worklet', stage === 'opus' ? 'wasm-opus' : 'pcm-wav');
    const rejected = assert.rejects(started, { name: 'AbortError' });
    await drain(); assert.equal(typeof release, 'function', stage);
    await recorder.stop(); await rejected;
    assert.equal(stream.track.readyState, 'ended', stage);
    assert.equal(pendingContext.state, 'closed', stage);
    if (stage === 'opus') assert.equal(workers[0].terminated, true);
    release(); await drain();
    assert.equal(recorder.pipelineStrategy, null);
    assert.equal(recorder.audioContext, null);
    assert.equal(recorder.isRecording, false);
  }
});

test('Opus completion rejects missing audio packets instead of saving a header-only file', async context => {
  reset(); context.mock.method(console, 'error', () => {});
  globalThis.Worker = class extends Worker {
    postMessage(data) {
      if (data.command === 'done') queueMicrotask(() => this.onmessage?.({ data: { message: 'done' } }));
      else super.postMessage(data);
    }
  };
  const wrapper = await createOpusWorker({ sampleRate: 48000, channels: 1 });
  wrapper.encode(new Float32Array(960));
  await assert.rejects(wrapper.finish(), /no audio packets/);
  wrapper.terminate();
});

test('Stereo Opus residual frames are zero padded without inflating captured duration', async () => {
  reset(); const context = new AudioContext(); context.sampleRate = 44100;
  const pipeline = new WorkletPipeline(context, new AudioNode(), null);
  await pipeline.setup({ channels: 2, encoder: 'wasm-opus' }); pipeline.startCapture(); await drain();
  const samples = [new Float32Array(1000).fill(0.25), new Float32Array(1000).fill(-0.5)];
  pipeline.nodes.worklet.input(samples); await pipeline.stopCapture();
  const result = await pipeline.finishOpusEncoding();
  const blocks = workers[0].messages.filter(message => message.command === 'encode');
  assert.deepEqual(blocks.map(block => block.buffers.map(channel => channel.length)), [[882, 882], [882, 882]]);
  assert.equal(blocks[1].buffers[1][117], -0.5); assert.equal(blocks[1].buffers[1][118], 0);
  assert.equal(result.sampleCount, 1000); assert.equal(result.encoderPaddingFrames, 764);
  assert.equal(result.duration, 1000 / 44100); await pipeline.cleanup();
});

test('Missing worklet acknowledgement fails rather than hanging the stop operation', async context => {
  reset(); const pipeline = new WorkletPipeline(new AudioContext(), new AudioNode(), null);
  await pipeline.setup({ encoder: 'pcm-wav' }); pipeline.startCapture(); await drain();
  pipeline.nodes.worklet.port.postMessage = () => {};
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const stopped = pipeline.stopCapture();
  context.mock.timers.tick(RECORDING.WORKLET_STOP_TIMEOUT_MS);
  await assert.rejects(stopped, /did not acknowledge/);
  await pipeline.cleanup(); context.mock.timers.reset();
});

test('WAV worker synchronous transport failure terminates the worker and rejects', async () => {
  reset(); globalThis.Worker = class extends Worker { postMessage() { throw new Error('WAV transport failed'); } };
  await assert.rejects(createWavBlob([new Float32Array(128)], 48000), /WAV transport failed/);
  assert.equal(workers[0].terminated, true);
});

test('WAV worker timeout terminates the worker and rejects', async context => {
  reset(); globalThis.Worker = class extends Worker { postMessage() {} };
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const result = createWavBlob([new Float32Array(128)], 48000);
  context.mock.timers.tick(30000);
  await assert.rejects(result, /WAV encoding timed out/);
  assert.equal(workers[0].terminated, true); context.mock.timers.reset();
});
