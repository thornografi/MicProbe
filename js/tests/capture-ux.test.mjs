import test from 'node:test';
import assert from 'node:assert/strict';
import CaptureGuide from '../modules/CaptureGuide.js';
import CaptureGuideUI from '../ui/CaptureGuideUI.js';
import { captureOutcome, projectCaptureTiming } from '../modules/CaptureOutcome.js';
import { countsAsCompletedTest } from '../modules/MeasurementValidity.js';
import { projectReviewReport } from '../modules/ReviewEvidence.js';
import { analyzePcm } from '../modules/utils/pcmAnalysis.js';
import evaluator from '../modules/ReportEvaluator.js';
import eventBus from '../modules/EventBus.js';
import { EVENTS } from '../modules/constants.js';

const processing = { autoGainControl: false, echoCancellation: false, noiseSuppression: false };
const timing = (ms, reason = 'user', interrupted = false) => ({ stopReason: reason, durationMs: ms,
  guidedSegments: { version: 1, method: 'user-guided-file-segments', interrupted, processing,
    quiet: ms < 3000 ? null : { startMs: 500, endMs: 2500 },
    speaking: ms < 3000 ? null : { startMs: 3500, endMs: ms - 500 } } });

test('quiet-only and short speaking samples remain playable evidence without warnings or test charges', () => {
  for (const type of ['record', 'test']) for (const ms of [200, 1000, 4000, 6500]) {
    const recording = timing(ms);
    const audioMetrics = analyzePcm([new Float32Array(ms * 16)], 16000, { guidedSegments: recording.guidedSegments });
    const report = { run: { type }, recording, audioMetrics };
    const result = evaluator.evaluateFree(report);
    assert.equal(result.overall.label, 'Test incomplete');
    assert.equal(result.assessment.status, 'insufficient');
    assert.deepEqual(result.findings, []);
    assert.match(result.summary, /before.*speaking section/);
    assert.doesNotMatch(result.nextStep, /\b(unmuted|gain|distance)\b/);
    assert.equal(countsAsCompletedTest(report), false);
    assert.equal(audioMetrics.status, 'measured', 'keep recorded PCM evidence for playback and diagnostics');
    assert.equal(countsAsCompletedTest({ audioMetrics, recording: projectCaptureTiming(recording) }), false);
    const projected = projectReviewReport(report);
    assert.equal(captureOutcome(projected.recording, ms).incomplete, true, 'review transport retains the same timing decision');
  }
});

test('sufficient early and normal samples remain assessable even when optional SNR is unavailable', () => {
  for (const [ms, reason] of [[7000, 'user'], [10000, 'guided-complete']]) {
    const recording = timing(ms, reason);
    recording.guidedSegments.processing.autoGainControl = true;
    const samples = Float32Array.from({ length: ms * 16 }, (_, i) =>
      (i < 48000 ? 0.001 : 0.1) * Math.sin(2 * Math.PI * 500 * i / 16000));
    const audioMetrics = analyzePcm([samples], 16000, { guidedSegments: recording.guidedSegments });
    const report = { run: { type: 'record' }, recording, audioMetrics };
    const result = evaluator.evaluateFree(report);
    assert.equal(countsAsCompletedTest(report), true);
    assert.equal(result.assessment.status, 'limited');
    assert.equal(audioMetrics.snr.status, 'unavailable');
    assert.equal(result.summary.includes('stopped the recording early'), reason === 'user');
    recording.guidedSegments.interrupted = true;
    assert.equal(countsAsCompletedTest(report), false);
    assert.match(evaluator.evaluateFree(report).summary, /page was hidden/);
  }
});

test('device loss, hidden short recordings and old unguided samples keep distinct outcomes', () => {
  assert.match(captureOutcome(timing(1000, 'device-ended'), 1000).message, /microphone disconnected/);
  assert.equal(captureOutcome(timing(1000, 'user', true), 1000).incomplete, true);
  assert.deepEqual(captureOutcome({ stopReason: 'user' }, 1000),
    { early: false, incomplete: false, interrupted: false, message: '' });
  assert.equal(captureOutcome(timing(7000), 4500).incomplete, true, 'decoded duration bounds claimed segments');
});

test('one run clock counts down through preparation, quiet and speaking to one automatic stop', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0, stopped = 0;
  t.mock.method(performance, 'now', () => now);
  const guide = new CaptureGuide({ runId: 'clock-run', captureGuide: { enabled: true, noiseCheck: true } });
  const counts = [], stages = [];
  const offCount = eventBus.on(EVENTS.TEST_COUNTDOWN, value => counts.push(value));
  const offStage = eventBus.on(EVENTS.CAPTURE_GUIDE_CHANGED, value => stages.push(value.stage));
  t.after(() => { guide.cancel(); offCount(); offStage(); });
  const preparing = guide.prepare({ getAudioTracks: () => [] });
  assert.equal(counts.at(-1).remainingSec, 2);
  now = 1000; t.mock.timers.tick(1000);
  assert.equal(counts.at(-1).remainingSec, 1);
  now = 2000; t.mock.timers.tick(1000); assert.equal(await preparing, true);
  guide.start(now, () => { stopped++; guide.finish(now - 2000, 'guided-complete'); });
  for (let second = 1; second <= 10; second++) {
    now += 1000; t.mock.timers.tick(1000);
    assert.equal(counts.at(-1).remainingSec, 10 - second);
  }
  assert.equal(stopped, 1);
  assert.deepEqual(stages, ['prepare', 'quiet', 'speak', 'captured']);
  assert.ok(counts.every(value => value.runId === 'clock-run'));
  now += 10000; t.mock.timers.tick(10000); assert.equal(stopped, 1);
});

test('delayed prompts cannot extend the advertised finish time or invent a complete speaking segment', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0, result;
  t.mock.method(performance, 'now', () => now);
  const guide = new CaptureGuide({ runId: 'delay-run', captureGuide: { enabled: true, noiseCheck: true } });
  t.after(() => guide.cancel());
  guide.start(0, () => { result = guide.finish(now, 'guided-complete'); });
  now = 8000; t.mock.timers.tick(8000);
  now = 10000; t.mock.timers.tick(2000);
  assert.equal(captureOutcome({ guidedSegments: result }, now).incomplete, true);
  assert.equal(guide.deadline, 10000);
});

test('returning to a hidden guided test explains the interruption and retains it in the saved evidence', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const oldDocument = globalThis.document;
  globalThis.document = Object.assign(new EventTarget(), { hidden: false });
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const guide = new CaptureGuide({ runId: 'hidden-run', captureGuide: { enabled: true, noiseCheck: true } });
  const states = [], unsubscribe = eventBus.on(EVENTS.CAPTURE_GUIDE_CHANGED, value => states.push(value));
  t.after(() => { guide.dispose(); unsubscribe(); globalThis.document = oldDocument; });
  guide.start(0, () => {});
  document.hidden = true; document.dispatchEvent(new Event('visibilitychange'));
  now = 3000; t.mock.timers.tick(3000);
  document.hidden = false; document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(states.at(-1).stage, 'speak');
  assert.equal(states.at(-1).interrupted, true);
  const segments = guide.finish(10000, 'guided-complete');
  assert.equal(segments.interrupted, true);
  assert.equal(captureOutcome({ guidedSegments: segments }, 10000).incomplete, false);
  assert.match(states.at(-1).outcome.message, /page was hidden/);
  const completedEvents = states.length;
  document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(states.length, completedEvents, 'finished guide releases the visibility listener');
});

test('shared countdown rejects late runs and terminal events, and hides after cancellation', t => {
  const oldDocument = globalThis.document, nodes = new Map();
  const summary = {}, disclosure = { querySelector: () => summary };
  globalThis.document = { getElementById(id) {
    if (!nodes.has(id)) nodes.set(id, { hidden: true, textContent: '', closest: () => disclosure });
    return nodes.get(id);
  } };
  const ui = new CaptureGuideUI();
  t.after(() => { ui.destroy(); globalThis.document = oldDocument; });
  const stage = value => eventBus.emit(EVENTS.CAPTURE_GUIDE_CHANGED, { runId: 'new', guided: true, ...value });
  stage({ stage: 'prepare', micName: 'Test mic' });
  eventBus.emit(EVENTS.TEST_COUNTDOWN, { runId: 'new', remainingSec: 2, phase: 'prepare' });
  assert.equal(nodes.get('recordingTimer').textContent, 'Starting in 2s');
  eventBus.emit(EVENTS.TEST_COUNTDOWN, { runId: 'old', remainingSec: 8 });
  assert.equal(nodes.get('recordingTimer').textContent, 'Starting in 2s');
  stage({ stage: 'quiet', inputDetected: false });
  assert.doesNotMatch(nodes.get('captureGuideStatus').textContent, /No input/);
  stage({ stage: 'cancelled' });
  eventBus.emit(EVENTS.TEST_COUNTDOWN, { runId: 'new', remainingSec: 1 });
  assert.equal(nodes.get('recordingTimer').hidden, true);
});
