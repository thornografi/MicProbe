const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { captureOutcome } = require('../modules/CaptureOutcome.js');

const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const constants = vm.runInNewContext(read('js/modules/constants.js').replaceAll('export const ', 'const ')
  + '\n({TEST, EVENTS, PIPELINE_TYPES, ENCODER_TYPES, LOOPBACK})', { location: { hostname: 'localhost' } });
const log = new Proxy({}, { get: () => () => {} });
const timers = { setTimeout: () => 1, clearTimeout() {}, setInterval: () => 2, clearInterval() {} };
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function stream(name) {
  const listeners = new Map();
  const track = { label: name, stopped: 0, muted: false, readyState: 'live', enabled: true,
    stop() { this.stopped++; this.readyState = 'ended'; }, getSettings: () => ({ channelCount: 1 }),
    addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(callback); },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
    end() { this.readyState = 'ended'; listeners.get('ended')?.forEach(callback => callback()); },
    listenerCount: () => [...listeners.values()].reduce((sum, callbacks) => sum + callbacks.size, 0) };
  return { id: name, active: true, track, getAudioTracks: () => [track], getTracks: () => [track] };
}
const stopStreamTracks = s => s?.getTracks().forEach(t => t.stop());

function testFlow(overrides = {}) {
  const events = [], recorders = [], playback = [], analyses = [], logs = [];
  let nextRun = 0, now = 0;
  const deps = {
    getConstraints: () => ({}), getOpusBitrate: () => 32000,
    createRunSnapshot: () => ({ runId: 'run-' + ++nextRun, requestedSettings: { pipeline: 'direct' } }),
    getIsPreparing: () => false, setIsPreparing() {}, setCurrentMode() {},
    player: { pause() {}, load(data) { playback.push(data); } }, uiStateManager: { updateButtonStates() {} }
  };
  const code = read('js/modules/CaptureGuide.js').replace(/^import .*;$/gm, '')
    .replace('export default class CaptureGuide', 'class CaptureGuide') + '\n'
    + read('js/controllers/TestRecordingFlow.js').replace(/^import .*;$/gm, '')
    .replace('export default TestRecordingFlow;', 'TestRecordingFlow;');
  const Flow = vm.runInNewContext(code, { ...constants, ...(overrides.timers || timers), Blob, AbortController, DOMException, captureOutcome,
    eventBus: { emit(type, data) { events.push({ type, data }); } },
    log: new Proxy({}, { get: (_, type) => (message, details) => logs.push({ type, message, details }) }), stopStreamTracks,
    performance: { now: () => now += 1000 },
    requestStream: overrides.requestStream || (async () => stream('microphone')),
    loopbackManager: overrides.loopbackManager || { actualPipeline: 'direct', audioCtx: null, setup: async () => stream('remote'), cleanup: async () => {} },
    createAndPlayActivatorAudio: overrides.activator || (async () => ({ cleaned: 0 })),
    cleanupActivatorAudio: a => { if (a) a.cleaned++; },
    createMediaRecorder: () => {
      const recorder = { state: 'inactive', mimeType: 'audio/webm', starts: 0,
        start() { this.starts++; this.state = 'recording'; },
        stop() { this.state = 'inactive'; queueMicrotask(() => { this.ondataavailable?.({ data: new Blob(['audio']) }); this.onstop?.(); }); } };
      recorders.push(recorder); return recorder;
    },
    deepAnalysisEngine: {
      analyze: overrides.analyze || (async (blob, options) => { analyses.push({ blob, options }); return { runId: options.runId, status: 'ready', audioMetrics: {} }; }),
      cancel() {}
    },
    completeRunSnapshot: (snapshot, source, execution) => ({ ...snapshot, ...execution, device: { micName: source.track.label } }),
    beginPreparing() {}, endPreparing() {}, resetState() {}, getStreamErrorMessage: e => e.message,
    formatTimestampYYMMDDHHMMSS: () => 'date', getExtensionForMimeType: () => 'webm'
  });
  return { flow: new Flow(deps), events, recorders, playback, analyses, logs };
}

test('call quota refusal and cancellation before admission never open a microphone', async () => {
  let microphones = 0, paused = 0, released;
  const f = testFlow({ requestStream: async () => { microphones++; return stream('mic'); } });
  f.flow.deps.player.pause = () => { paused++; };
  f.flow.deps.testAccess = { begin: async () => false, release: async id => { released = id; } };
  await f.flow.startRecording();
  assert.equal(microphones, 0); assert.equal(paused, 0);
  const gate = deferred();
  f.flow.deps.testAccess.begin = () => gate.promise;
  const starting = f.flow.startRecording();
  await f.flow.cancel();
  gate.resolve(true); await starting;
  assert.equal(microphones, 0); assert.equal(paused, 0); assert.equal(released, 'run-2');
});

test('an ended microphone is rejected before setup, after setup, and after activation', async () => {
  for (const stage of ['permission', 'setup', 'activation']) {
    const local = stream('microphone'), activator = { cleaned: 0 };
    let cleanups = 0;
    const h = testFlow({
      requestStream: async () => { if (stage === 'permission') local.track.stop(); return local; },
      loopbackManager: { actualPipeline: 'direct', setup: async () => {
        if (stage === 'setup') local.track.stop(); return stream('remote');
      }, cleanup: async () => { cleanups++; } },
      activator: async () => { if (stage === 'activation') local.track.stop(); return activator; }
    });
    await h.flow.startRecording();
    assert.equal(h.recorders.length, 0, `${stage}: cannot record an ended input`);
    assert.equal(h.flow.testPhase, null);
    assert.equal(h.flow.localStream, null);
    assert.equal(local.track.listenerCount(), 0);
    assert.ok(cleanups > 0);
    assert.ok(h.events.some(e => e.type === constants.EVENTS.UI_MESSAGE && e.data.message.includes('Microphone disconnected')));
    assert.equal(h.events.filter(e => e.type === constants.EVENTS.TEST_CANCELLED).length, 1);
    if (stage === 'activation') assert.ok(activator.cleaned > 0);
  }
});

test('device loss during pending setup cancels promptly; late setup cannot touch a replacement run', async () => {
  const setup = deferred(), oldLocal = stream('old'); let calls = 0;
  const h = testFlow({ requestStream: async () => calls ? stream('new') : oldLocal,
    loopbackManager: { actualPipeline: 'direct', setup: () => ++calls === 1 ? setup.promise : Promise.resolve(stream('remote')), cleanup: async () => {} } });
  const oldStart = h.flow.startRecording(); await tick();
  oldLocal.track.end(); await tick();
  assert.equal(h.flow.testPhase, null); assert.equal(h.flow.localStream, null);
  assert.equal(oldLocal.track.listenerCount(), 0);
  await h.flow.startRecording();
  const current = h.flow.localStream;
  setup.resolve(stream('old-remote')); await oldStart;
  assert.equal(h.flow.localStream, current); assert.equal(current.track.readyState, 'live');
  assert.equal(h.flow.testPhase, 'recording'); assert.equal(h.recorders.length, 1);
  await h.flow.cancel();
});

test('MediaRecorder error explains the failure once, clears resources and cannot cancel a newer run', async () => {
  const h = testFlow(); await h.flow.startRecording();
  const local = h.flow.localStream, activator = h.flow._run.activator, media = h.recorders[0];
  const errorHandler = media.onerror;
  errorHandler({ error: new Error('encoder device failure') });
  errorHandler({ error: new Error('duplicate failure') }); await tick();
  const messages = h.events.filter(e => e.type === constants.EVENTS.UI_MESSAGE);
  assert.equal(messages.length, 1); assert.match(messages[0].data.message, /encoder device failure.*try Test again/);
  assert.ok(h.logs.some(entry => entry.type === 'error' && entry.details?.error === 'encoder device failure'));
  assert.equal(h.flow.testPhase, null); assert.equal(local.track.readyState, 'ended');
  assert.equal(local.track.listenerCount(), 0); assert.ok(activator.cleaned > 0);
  assert.equal(h.events.filter(e => e.type === constants.EVENTS.TEST_COMPLETED).length, 0);
  assert.equal(h.events.filter(e => e.type === constants.EVENTS.TEST_CANCELLED).length, 1);
  await h.flow.startRecording(); const current = h.flow.localStream;
  errorHandler({ error: new Error('late old failure') }); await tick();
  assert.equal(h.flow.localStream, current); assert.equal(current.track.readyState, 'live');
  await h.flow.cancel();
});

test('missing MediaRecorder stop event times out once and a late callback cannot publish a report', async () => {
  const pending = new Map(); let sequence = 0;
  const h = testFlow({ timers: { ...timers, setTimeout: (fn, delay) => {
    const id = ++sequence; pending.set(id, { fn, delay }); return id;
  }, clearTimeout: id => pending.delete(id) } });
  await h.flow.startRecording();
  const local = h.flow.localStream, media = h.recorders[0];
  media.stop = () => { media.state = 'inactive'; };
  const stopped = h.flow.stopRecording();
  assert.equal(h.flow.stopRecording(), stopped);
  assert.equal(local.track.readyState, 'ended');
  const lateStop = media.onstop;
  const timeout = [...pending.values()].find(timer => timer.delay === constants.TEST.STOP_WAIT_MS);
  assert.ok(timeout); timeout.fn(); await stopped;
  assert.equal(h.flow.testPhase, null); assert.equal(h.flow.localStream, null);
  assert.equal(pending.size, 0); assert.equal(h.playback.length, 0);
  assert.ok(h.logs.some(entry => /timed out/.test(entry.details?.error)));
  assert.equal(h.events.filter(e => e.type === constants.EVENTS.TEST_CANCELLED).length, 1);
  lateStop(); await tick();
  assert.equal(h.events.filter(e => e.type === constants.EVENTS.TEST_COMPLETED).length, 0);
});

test('cancelling a pending MediaRecorder stop clears its timeout without a second terminal event', async () => {
  const pending = new Map(); let sequence = 0;
  const h = testFlow({ timers: { ...timers, setTimeout: (fn, delay) => {
    const id = ++sequence; pending.set(id, { fn, delay }); return id;
  }, clearTimeout: id => pending.delete(id) } });
  await h.flow.startRecording();
  h.recorders[0].stop = () => { h.recorders[0].state = 'inactive'; };
  const stopped = h.flow.stopRecording(); await h.flow.cancel(); await stopped;
  assert.equal(pending.size, 0); assert.equal(h.playback.length, 0);
  assert.equal(h.events.filter(e => e.type === constants.EVENTS.TEST_CANCELLED).length, 1);
});

test('test completion still publishes one matching run and measures the blob loaded into playback', async () => {
  const h = testFlow();
  await h.flow.startRecording();
  const stop = h.flow.stopRecording();
  assert.equal(h.flow.stopRecording(), stop);
  await stop;
  assert.equal(h.analyses.length, 1);
  assert.equal(h.playback.length, 1);
  assert.equal(h.analyses[0].blob, h.playback[0].blob);
  const stopped = h.events.filter(e => e.type === constants.EVENTS.TEST_RECORDING_STOPPED);
  const completed = h.events.filter(e => e.type === constants.EVENTS.TEST_COMPLETED);
  assert.equal(stopped.length, 1); assert.equal(completed.length, 1);
  assert.equal(completed[0].data.runSnapshot.runId, completed[0].data.analysis.runId);
  assert.equal(h.flow.testPhase, null);
  assert.equal(h.flow.localStream, null);
});

test('call completion keeps the final file MIME and reported encoder bitrate separate from RTP', async () => {
  const h = testFlow();
  await h.flow.startRecording();
  assert.equal(h.flow.runSnapshot.encoder, null, 'setup must not invent an actual Opus codec');
  const recorder = h.recorders[0];
  recorder.stop = () => {
    recorder.state = 'inactive';
    queueMicrotask(() => {
      recorder.mimeType = 'audio/mp4;codecs=mp4a.40.2';
      recorder.audioBitsPerSecond = 128000;
      recorder.ondataavailable({ data: new Blob(['final file'], { type: recorder.mimeType }) });
      recorder.onstop();
    });
  };
  await h.flow.stopRecording();
  const completed = h.events.find(e => e.type === constants.EVENTS.TEST_COMPLETED).data;
  assert.equal(completed.runSnapshot.runId, h.playback[0].runSnapshot.runId);
  assert.equal(completed.recording.mimeType, 'audio/mp4;codecs=mp4a.40.2');
  assert.equal(completed.recording.mimeTypeSource, 'mediarecorder');
  assert.equal(completed.recording.encoder, 'mediarecorder');
  assert.equal(completed.recording.encoderReportedBitrate, 128000);
  assert.equal(completed.recording.blobSize, h.playback[0].blob.size);
  assert.equal(completed.recording.durationMs, h.playback[0].durationMs);
  assert.equal(h.playback[0].blob.type, completed.recording.mimeType);
  assert.equal(h.playback[0].mimeType, completed.recording.mimeType);
  assert.equal(completed.recording.actualBitrate, undefined, 'API-reported bitrate is not measured throughput');
});

test('an inactive recorder uses its emitted MIME, and absent encoding metadata remains unknown', async () => {
  for (const chunkType of ['audio/ogg;codecs=opus', '']) {
    const h = testFlow();
    await h.flow.startRecording();
    const recorder = h.recorders[0];
    recorder.mimeType = '';
    recorder.audioBitsPerSecond = NaN;
    recorder.ondataavailable({ data: new Blob(['audio'], { type: chunkType }) });
    recorder.state = 'inactive';
    await h.flow.stopRecording();
    const { recording } = h.events.find(e => e.type === constants.EVENTS.TEST_COMPLETED).data;
    assert.equal(recording.mimeType, chunkType || null);
    assert.equal(recording.mimeTypeSource, chunkType ? 'dataavailable' : null);
    assert.equal(recording.encoderReportedBitrate, null);
    assert.equal(h.playback[0].blob.type, chunkType, 'unknown MIME must not become invented WebM');
  }
});

test('late microphone permission from a cancelled test cannot replace or stop a newer test', async () => {
  const oldPermission = deferred(), newPermission = deferred(); let calls = 0;
  const h = testFlow({ requestStream: () => ++calls === 1 ? oldPermission.promise : newPermission.promise });
  const oldStart = h.flow.startRecording(); await h.flow.cancel();
  const newStart = h.flow.startRecording();
  const current = stream('current'); newPermission.resolve(current); await newStart;
  const stale = stream('stale'); oldPermission.resolve(stale); await oldStart;
  assert.equal(h.flow.localStream, current);
  assert.equal(current.track.stopped, 0);
  assert(stale.track.stopped > 0);
  assert.equal(h.recorders.length, 1);
  assert.equal(h.flow.runSnapshot.runId, 'run-2');
  await h.flow.cancel();
});

test('late activator after cancel cannot create a recorder or close the new run', async () => {
  const pending = deferred(); let activations = 0;
  const h = testFlow({ activator: () => ++activations === 1 ? pending.promise : Promise.resolve({ cleaned: 0 }) });
  const oldStart = h.flow.startRecording(); await tick();
  assert.equal(activations, 1);
  await h.flow.cancel(); await h.flow.startRecording();
  const current = h.flow.localStream;
  const stale = { cleaned: 0 }; pending.resolve(stale); await oldStart;
  assert(stale.cleaned > 0);
  assert.equal(h.recorders.length, 1);
  assert.equal(h.flow.localStream, current);
  assert.equal(current.track.stopped, 0);
  await h.flow.cancel();
});

test('late cancelled analysis cannot overwrite a newer test or publish completion', async () => {
  const analysis = deferred(); const h = testFlow({ analyze: () => analysis.promise });
  await h.flow.startRecording(); const oldStop = h.flow.stopRecording(); await tick();
  assert.equal(h.flow.testPhase, 'analysing');
  await h.flow.cancel(); await h.flow.startRecording();
  analysis.resolve({ runId: 'run-1', status: 'ready' }); await oldStop;
  assert.equal(h.flow.runSnapshot.runId, 'run-2');
  assert.equal(h.flow.testPhase, 'recording');
  assert.equal(h.flow.analysis, null);
  assert.equal(h.playback.length, 0);
  assert.equal(h.events.filter(e => e.type === constants.EVENTS.TEST_COMPLETED).length, 0);
  await h.flow.cancel();
});

function context(name, close = async () => {}) {
  const node = () => ({ connect() {}, disconnect() {} });
  return { name, state: 'running', sampleRate: 48000, destination: node(), closed: 0,
    async close() { this.closed++; await close(); }, createMediaStreamSource: node,
    createMediaStreamDestination: () => ({ ...node(), stream: stream(name + '-send') }) };
}

function loopback(overrides = {}) {
  const peers = [], events = [];
  class Peer {
    constructor() { this.iceConnectionState = 'connected'; this.closed = false; peers.push(this); }
    addTrack() {} addEventListener() {} removeEventListener() {}
    close() { this.closed = true; this.iceConnectionState = 'closed'; }
    async createOffer() { return { type: 'offer', sdp: 'a=rtpmap:111 opus/48000/2\r\n' }; }
    async createAnswer() { return { type: 'answer', sdp: 'a=rtpmap:111 opus/48000/2\r\n' }; }
    async setLocalDescription() {}
    async setRemoteDescription() { if (this.ontrack) { const remote = stream('remote'); this.ontrack({ track: remote.track, streams: [remote] }); } }
    async addIceCandidate() {}
  }
  const code = read('js/modules/LoopbackManager.js').replace(/^import .*;$/gm, '')
    .replace('export default loopbackManager;', 'LoopbackManager;');
  const Manager = vm.runInNewContext(code, { ...constants, ...(overrides.timers || timers), log, AbortController,
    eventBus: { emit(type, data) { events.push({ type, data }); } }, RTCPeerConnection: Peer,
    stopStreamTracks, disconnectNodes: nodes => nodes.forEach(n => n?.disconnect?.()),
    getAudioContextOptions: () => ({}), createAudioContext: overrides.createContext || (async () => context('audio')),
    ensurePassthroughWorklet: overrides.ensureWorklet || (async () => {}),
    createPassthroughWorkletNode: () => ({ connect() {}, disconnect() {} }),
    summarizeLoopbackStats: overrides.summarizeLoopbackStats || (() => ({}))
  });
  return { manager: new Manager(), peers, events };
}

test('a cancelled setup closes its late context without touching a newer peer session', async () => {
  const late = deferred(); let calls = 0; const currentContext = context('new');
  const h = loopback({ createContext: () => ++calls === 1 ? late.promise : Promise.resolve(currentContext) });
  const staleSetup = h.manager.setup(stream('old'), { useWebAudio: true }); await tick();
  const rejected = assert.rejects(staleSetup, /cancelled/);
  await h.manager.cleanup(); await h.manager.setup(stream('new'), { useWebAudio: true });
  const currentPeer = h.manager.pc1;
  const staleContext = context('old'); late.resolve(staleContext); await rejected;
  assert.equal(staleContext.closed, 1);
  assert.equal(h.manager.audioCtx, currentContext);
  assert.equal(h.manager.pc1, currentPeer);
  assert.equal(currentPeer.closed, false);
  await h.manager.cleanup();
});

test('old cleanup awaiting context.close cannot erase a replacement setup', async () => {
  const closing = deferred(); const h = loopback(); h.manager.audioCtx = context('closing', () => closing.promise);
  const oldSetup = h.manager.setup(stream('old'));
  const rejected = assert.rejects(oldSetup, /cancelled/);
  await h.manager.setup(stream('new'));
  const current = h.manager.pc1; closing.resolve(); await rejected;
  assert.equal(h.manager.pc1, current);
  assert.equal(current.closed, false);
  await h.manager.cleanup();
});

test('late codec stats from closed peers cannot become the replacement run provenance', async () => {
  let poll;
  let summaries = 0;
  const pending = deferred();
  const h = loopback({
    timers: { ...timers, setInterval: callback => { poll = callback; return 2; } },
    summarizeLoopbackStats: () => {
      summaries++;
      return { previous: null, stats: { senderCodec: { mimeType: 'audio/opus' }, receiverCodec: null } };
    }
  });
  await h.manager.setup(stream('old'), { runId: 'old' });
  h.manager.pc1.getStats = () => pending.promise;
  h.manager.pc2.getStats = async () => [];
  const oldPoll = poll();
  await h.manager.cleanup();
  await h.manager.setup(stream('new'), { runId: 'new', opusBitrate: 24000 });
  pending.resolve([]);
  await oldPoll;
  assert.equal(summaries, 0);
  assert.equal(h.events.filter(e => e.type === constants.EVENTS.LOOPBACK_STATS).length, 0);
  h.manager.pc1.getStats = async () => [];
  h.manager.pc2.getStats = async () => [];
  await poll();
  const current = h.events.find(e => e.type === constants.EVENTS.LOOPBACK_STATS).data;
  assert.equal(current.runId, 'new');
  assert.equal(current.requestedCodec, 'audio/opus');
  assert.equal(current.requestedBitrate, 24000);
  assert.equal(current.senderCodec.mimeType, 'audio/opus');
  await h.manager.cleanup();
});
