import test from 'node:test';
import assert from 'node:assert/strict';
import eventBus from '../modules/EventBus.js';
import { EVENTS, ENCODER_TYPES } from '../modules/constants.js';

// Only the browser storage and window boundaries are faked.
globalThis.window = new EventTarget();
globalThis.indexedDB = { open: () => ({}) };
const { default: logManager } = await import('../modules/LogManager.js');

test.beforeEach(() => {
  for (const entries of Object.values(logManager.logs)) entries.length = 0;
});

const stream = {
  getAudioTracks: () => [{ id: 'track', label: 'Microphone', getSettings: () => ({ channelCount: 1 }) }]
};
const rewriteMessages = () => {
  for (const entry of logManager.getSessionLogs()) entry.message = 'Reworded display text';
};

for (const encoder of [ENCODER_TYPES.DEFAULT, ENCODER_TYPES.WASM_OPUS, ENCODER_TYPES.PCM_WAV, 'future-encoder']) {
  test(`lifecycle sanity survives message changes for ${encoder}`, () => {
    const details = { encoder, runId: 'record-one' };
    eventBus.emit(EVENTS.STREAM_STARTED, stream);
    eventBus.emit(EVENTS.RECORDER_STARTED, details);
    assert.equal(details.eventType, undefined, 'logging must not mutate the event payload');
    assert.equal(logManager.getByCategory('recorder')[0].details.runId, 'record-one');
    rewriteMessages();

    let report = logManager.getSanityReport();
    assert.equal(report.summary.recordingActive, true);
    assert.equal(report.summary.streamBalance, 1);
    assert(report.issues.some(issue => issue.code === 'RECORDING_ACTIVE'));

    eventBus.emit(EVENTS.RECORDER_STOPPED, details);
    eventBus.emit(EVENTS.STREAM_STOPPED);
    rewriteMessages();
    report = logManager.getSanityReport();
    assert.equal(report.summary.recordingActive, false);
    assert.equal(report.summary.streamBalance, 0);
    assert.equal(report.ok, true);
  });
}

test('plain log messages cannot impersonate lifecycle events', () => {
  logManager.log('stream', 'Stream started');
  logManager.log('stream', 'Stream stopped');
  logManager.log('recorder', 'MediaRecorder started');
  eventBus.emit(EVENTS.LOG_WEBAUDIO, {
    message: 'Setting changed', details: { setting: 'webAudioEnabled', value: true }
  });
  const report = logManager.getSanityReport();
  assert.equal(report.ok, true);
  assert.equal(report.summary.recordingActive, false);
  assert.equal(report.summary.streamBalance, 0);
  assert.equal(report.summary.lastWebAudioEnabled, true);
});

test('unmatched stream stop remains a warning regardless of its display text', () => {
  eventBus.emit(EVENTS.STREAM_STOPPED);
  rewriteMessages();
  const report = logManager.getSanityReport();
  assert(report.issues.some(issue => issue.code === 'STREAM_BALANCE_NEGATIVE'));
});
