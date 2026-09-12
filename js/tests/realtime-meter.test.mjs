import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import MeterSource from '../modules/MeterSource.js';
import VuMeter from '../modules/VuMeter.js';
import audioEngine from '../modules/AudioEngine.js';
import ScriptProcessorPipeline from '../pipelines/ScriptProcessorPipeline.js';
import { VU_METER } from '../modules/constants.js';

globalThis.AudioWorkletNode = undefined;
globalThis.window = undefined;

function processor(rate = 48000) {
  const messages = [];
  const scope = vm.createContext({
    sampleRate: rate, currentTime: 0,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: data => messages.push(data) }; } },
    registerProcessor: (_, ctor) => { scope.Processor = ctor; }
  });
  vm.runInContext(readFileSync(new URL('../worklets/meter-processor.js', import.meta.url), 'utf8'), scope);
  const node = new scope.Processor({ processorOptions: {
    intervalMs: VU_METER.SAMPLE_INTERVAL_MS,
    clipThreshold: 10 ** (VU_METER.CLIPPING_THRESHOLD_DB / 20),
    highThreshold: 10 ** (VU_METER.HIGH_LEVEL_DB / 20)
  } });
  return { node, messages, scope, block(samples) {
    const output = new Float32Array(samples.length);
    const active = node.process([[samples]], [[output]]);
    assert(output.every(value => value === 0), 'measurement never passes audio to speakers');
    scope.currentTime += samples.length / rate;
    return active;
  } };
}

for (const rate of [8000, 44100, 48000, 96000, 192000]) {
  test(`continuous meter sees a one-sample peak between display frames at ${rate} Hz`, () => {
    const p = processor(rate), frame = new Float32Array(128);
    frame[17] = -1;
    p.block(frame);
    for (let i = 0; i < 20; i++) p.block(new Float32Array(256));
    assert.equal(p.messages.length, 1, 'one in-flight packet even when no UI acknowledgement arrives');
    assert.equal(p.messages[0].peak, 1);
    assert(p.messages[0].rms > 0);
    p.node.port.onmessage({ data: 'ack' });
    for (let i = 0; i < 20; i++) p.block(new Float32Array(128));
    assert.equal(p.messages.length, 2);
    assert.equal(p.messages[1].rms, 0, 'latest RMS does not average old sound into the silence');
    assert.equal(p.messages[1].peak, 0);
    assert(p.messages[1].clipTime < p.messages[1].time, 'overload retains its audio timestamp');
    p.node.port.onmessage({ data: 'stop' });
    assert.equal(p.block(frame), false);
  });
}

test('a blocked page cannot grow the port queue or lose a peak recorded while its packet was pending', () => {
  const p = processor();
  for (let i = 0; i < 100; i++) p.block(new Float32Array(128));
  const pulse = new Float32Array(128); pulse[40] = 1;
  p.block(pulse);
  for (let i = 0; i < 1000; i++) p.block(new Float32Array(128));
  assert.equal(p.messages.length, 1);
  p.node.port.onmessage({ data: 'ack' });
  for (let i = 0; i < 4; i++) p.block(new Float32Array(128));
  assert.equal(p.messages.length, 2);
  assert.equal(p.messages[1].peak, 1);
  assert.equal(p.messages[1].rms, 0);
  assert(p.messages[1].time - p.messages[1].peakTime > 2);
});

function fakeAudio(t, { addModule = async () => {} } = {}) {
  const nodes = [];
  const context = Object.assign(new EventTarget(), { sampleRate: 48000, currentTime: 1, state: 'running', destination: {}, audioWorklet: { addModule } });
  const analyser = { context, fftSize: 256, connect() {}, disconnects: [],
    disconnect(node) { this.disconnects.push(node); },
    getFloatTimeDomainData(data) { data.fill(0.25); } };
  t.mock.property(globalThis, 'AudioWorkletNode', class {
    constructor(ctx, name, options) {
      Object.assign(this, { ctx, name, options });
      this.messages = [];
      this.port = { postMessage: data => this.messages.push(data), close: () => { this.portClosed = true; } };
      nodes.push(this);
    }
    connect() {}
    disconnect() { this.disconnected = true; }
  });
  return { context, analyser, nodes };
}

test('meter source merges peaks between paints but uses fresh RMS; stale sound never replays after a stall', async t => {
  let now = 100;
  t.mock.method(performance, 'now', () => now);
  const { analyser, context, nodes } = fakeAudio(t);
  const source = new MeterSource(analyser); await source.ready;
  const send = (data) => nodes[0].port.onmessage({ data: { sumSquares: data.rms ** 2 * 384, sampleCount: 384, ...data } });
  send({ rms: 0.3, livePeak: 1, peak: 1, peakTime: 1, time: 1, clipTime: 1, highTime: 1 });
  context.currentTime = 1.008; now += 8;
  send({ rms: 0.1, livePeak: 0.2, peak: 0.2, peakTime: 1.008, time: 1.008, clipTime: 1, highTime: 1 });
  const sampled = source.read();
  assert(Math.abs(sampled.rms - Math.sqrt(0.05)) < 1e-8, 'all packet energy between frames contributes to RMS');
  assert.equal(sampled.peak, 1);
  assert(Math.abs(sampled.clipAgeMs - 8) < 1e-8);
  assert.equal(source.read().peak, 0.2, 'consumed peak is not replayed');
  context.currentTime = 1.5; now += 492;
  send({ rms: 0, livePeak: 0, peak: 1, peakTime: 1.1, time: 1.5, clipTime: 1.1, highTime: 1.1 });
  assert.equal(source.read().peak, 0);
  assert(Math.abs(source.read().clipAgeMs - 400) < 0.001, 'late warning expires relative to the sound, not message arrival');
  now += 200;
  assert.equal(source.read().rms, 0, 'wall clock also ages a frozen audio clock');
  context.state = 'suspended'; context.dispatchEvent(new Event('statechange'));
  assert.equal(source.read().rms, 0);
  context.state = 'running'; context.dispatchEvent(new Event('statechange'));
  assert.equal(source.read().peak, 0, 'wait for fresh worklet data instead of reading the old analyser window');
  context.currentTime = 1.508;
  send({ rms: 0, livePeak: 0, peak: 1, peakTime: 1, time: 1.508, clipTime: 1, highTime: 1 });
  assert.equal(source.read().peak, 0, 'resume cannot revive sound from before suspension');
  assert.equal(source.read().clipAgeMs, Infinity);
  source.close();
  assert(nodes[0].portClosed && nodes[0].disconnected);
  assert.deepEqual(analyser.disconnects, [nodes[0]], 'only this sidechain is disconnected');
  assert.equal(context.state, 'running', 'shared context remains open');
});

test('worklet loading is shared and late completion after stop cannot attach a node', async t => {
  let finish, loads = 0;
  const { analyser, nodes } = fakeAudio(t, { addModule: () => { loads++; return new Promise(resolve => { finish = resolve; }); } });
  const first = new MeterSource(analyser), second = new MeterSource(analyser);
  first.close(); finish();
  await Promise.all([first.ready, second.ready]);
  assert.equal(loads, 1);
  assert.equal(nodes.length, 1);
  second.close();
});

test('load failure falls back and keeps recording-owned context and connections intact', async t => {
  const { analyser, nodes } = fakeAudio(t, { addModule: async () => { throw new Error('unavailable'); } });
  const source = new MeterSource(analyser); await source.ready;
  assert.equal(source.mode, 'analyser');
  assert.equal(source.read().rms, 0.25);
  assert(analyser.fftSize / analyser.context.sampleRate >= 0.025);
  assert.equal(nodes.length, 0);
  source.close();
});

test('processor failure disconnects the sidechain and switches back to analyser samples', async t => {
  const other = fakeAudio(t);
  const working = new MeterSource(other.analyser); await working.ready;
  other.nodes[0].onprocessorerror();
  assert.equal(working.read().peak, 0.25);
  assert(other.nodes[0].disconnected);
  working.close();
});

test('an AudioEngine resume finishing after cancellation cannot replace the current source', async t => {
  let resume;
  t.mock.method(audioEngine, 'resume', () => new Promise(resolve => { resume = resolve; }));
  const controller = new AbortController();
  const source = audioEngine.sourceNode;
  const pending = audioEngine.connectStream({}, { signal: controller.signal });
  controller.abort(); resume();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(audioEngine.sourceNode, source);
});

test('unsupported worklets keep an operational, sample-rate-aware analyser fallback', async t => {
  const { analyser } = fakeAudio(t);
  analyser.context.audioWorklet = null;
  const source = new MeterSource(analyser); await source.ready;
  assert.equal(source.mode, 'analyser');
  assert.deepEqual(source.read(), { rms: 0.25, peak: 0.25 });
  source.close();
});

test('a remote context awaiting resume is closed on stop and cannot attach a late stream', async t => {
  let resume, closes = 0;
  t.mock.property(globalThis, 'window', { AudioContext: class {
    constructor() { this.state = 'suspended'; }
    resume() { return new Promise(resolve => { resume = resolve; }); }
    async close() { closes++; this.state = 'closed'; }
    createMediaStreamSource() { assert.fail('cancelled remote stream must not attach'); }
  } });
  const oldRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = () => 1;
  t.after(() => { globalThis.requestAnimationFrame = oldRaf; });
  const meter = Object.create(VuMeter.prototype);
  const pending = meter.startRemote({});
  meter.stopRemote();
  resume(); await pending;
  assert.equal(closes, 1);
  assert.equal(meter.remoteAnalyser, null);
});

test('a meter stopped while AudioEngine warms up never connects the late stream', async t => {
  let ready;
  t.mock.method(audioEngine, 'warmup', () => new Promise(resolve => { ready = resolve; }));
  const connect = t.mock.method(audioEngine, 'connectStream', async () => { throw new Error('must not connect'); });
  t.mock.method(audioEngine, 'disconnect', () => {});
  const meter = Object.create(VuMeter.prototype);
  meter._ensureResizeHandler = () => {};
  const pending = meter.start({});
  meter.stop(); ready(); await pending;
  assert.equal(connect.mock.callCount(), 0);
  assert.equal(meter.analyser, null);
});

test('legacy input meter works during preparation without waiting for or changing the encoder callback', async () => {
  const node = () => ({ connections: [], connect(target) { this.connections.push(target); }, disconnect() {} });
  const input = node(), processor = node();
  const context = { createScriptProcessor: () => processor, createAnalyser: node,
    createGain: () => ({ ...node(), gain: { value: 1 } }), destination: {} };
  const pipeline = new ScriptProcessorPipeline(context, input);
  let encoded = 0;
  pipeline._initOpusWorker = async () => { pipeline.opusWorker = { encode: () => encoded++ }; return 64000; };
  await pipeline.setup({ channels: 1 });
  assert(input.connections.includes(pipeline.analyserNode));
  assert(!processor.connections.includes(pipeline.analyserNode));
  assert(processor.connections.includes(pipeline.analysisAnalyserNode), 'file/analysis branch keeps its existing source');
  const pcm = new Float32Array([0.25, -0.25]), output = new Float32Array(2);
  const frame = { inputBuffer: { getChannelData: () => pcm }, outputBuffer: { getChannelData: () => output } };
  processor.onaudioprocess(frame);
  assert.equal(encoded, 0, 'preparation is still excluded from encoding');
  assert(output.every(value => value === 0));
  pipeline.startCapture(); processor.onaudioprocess(frame);
  assert.equal(encoded, 1);
  assert.deepEqual(output, pcm);
  assert.equal(pipeline.capturedFrames, 2);
});
