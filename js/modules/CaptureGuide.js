import eventBus from './EventBus.js';
import { CAPTURE_GUIDE as GUIDE, EVENTS, TEST, VU_METER } from './constants.js';
import { captureOutcome } from './CaptureOutcome.js';

/** Run-owned cues. Live levels are readiness hints; only decoded file segments feed reports. */
export default class CaptureGuide {
  constructor(snapshot) {
    this.runId = snapshot.runId;
    this.enabled = snapshot.captureGuide?.enabled === true;
    this.guided = this.enabled && snapshot.captureGuide.noiseCheck === true;
    this.processing = null;
    this.timers = new Set();
    this.closed = false;
  }

  get durationMs() { return TEST.DURATION_MS + (this.guided ? GUIDE.QUIET_MS : 0); }

  publish(stage, extra = {}) {
    if (stage !== 'input-detected') this.stage = stage;
    if (this.enabled && !this.closed) eventBus.emit(EVENTS.CAPTURE_GUIDE_CHANGED,
      { runId: this.runId, stage, guided: this.guided, interrupted: !!this.interrupted, inputDetected: this.inputDetected, ...extra });
  }

  countdown(deadline, phase) {
    const remainingSec = Math.max(0, Math.ceil((deadline - performance.now()) / 1000));
    eventBus.emit(EVENTS.TEST_COUNTDOWN, { runId: this.runId, remainingSec, phase });
    return remainingSec;
  }

  later(callback, duration) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.closed) callback();
    }, duration);
    this.timers.add(timer);
  }

  prepare(stream) {
    if (!this.enabled) return Promise.resolve(true);
    this.micName = stream.getAudioTracks()[0]?.label || 'Selected microphone';
    const applied = stream.getAudioTracks()[0]?.getSettings?.() || {};
    this.processing = { autoGainControl: applied.autoGainControl ?? null, noiseSuppression: applied.noiseSuppression ?? null,
      echoCancellation: applied.echoCancellation ?? null };
    let detected = false;
    this.publish('prepare', { micName: this.micName });
    this.unsubscribeLevel = eventBus.on(EVENTS.VUMETER_LEVEL, ({ rawDb }) => {
      if (!detected && rawDb != null && rawDb !== '' && Number.isFinite(Number(rawDb)) && Number(rawDb) > VU_METER.SIGNAL_PRESENT_DB) {
        detected = true;
        this.publish('input-detected', { micName: this.micName });
      }
    });
    const tracks = stream.getAudioTracks();
    const onEnded = () => this.cancel();
    tracks.forEach(track => track.addEventListener?.('ended', onEnded));
    this.releasePreparationTracks = () => tracks.forEach(track => track.removeEventListener?.('ended', onEnded));
    return new Promise(resolve => {
      this.resolvePreparation = resolve;
      const deadline = performance.now() + GUIDE.PREPARE_MS;
      const tick = () => {
        if (this.countdown(deadline, 'prepare') > 0) { this.later(tick, Math.min(1000, deadline - performance.now())); return; }
        this.unsubscribeLevel?.(); this.unsubscribeLevel = null;
        this.releasePreparationTracks?.(); this.releasePreparationTracks = null;
        this.resolvePreparation = null;
        this.inputDetected = detected;
        resolve(true);
      };
      tick();
    });
  }

  start(startedAt, onComplete) {
    if (!this.enabled || this.closed) return;
    this.startedAt = startedAt;
    if (!this.guided) { this.publish('speak'); return; }
    // A hidden page cannot reliably present the prompts. Preserve the audio, but reject its segment estimate.
    this.interrupted = globalThis.document?.hidden === true;
    this.onVisibility = () => {
      if (document.hidden) this.interrupted = true;
      else if (this.interrupted) this.publish(this.stage);
    };
    globalThis.document?.addEventListener?.('visibilitychange', this.onVisibility);
    this.publish('quiet');
    this.deadline = startedAt + this.durationMs;
    const tick = () => {
      const remaining = this.countdown(this.deadline, 'capture');
      if (!remaining) { onComplete(); return; }
      if (this.speechCueMs == null && performance.now() - this.startedAt >= GUIDE.QUIET_MS) {
        this.speechCueMs = performance.now() - this.startedAt;
        this.publish('speak');
      }
      // One clock owns both the displayed deadline and automatic stop. A delayed
      // prompt never adds time or fabricates the missing speaking segment.
      this.later(tick, Math.min(1000, this.deadline - performance.now()));
    };
    tick();
  }

  finish(durationMs, stopReason = 'user') {
    if (this.closed) return this.segments || null;
    if (this.guided) {
      const margin = GUIDE.EDGE_MARGIN_MS;
      this.segments = {
        version: 1, method: 'user-guided-file-segments', durationMs,
        interrupted: !!this.interrupted,
        processing: this.processing,
        quiet: this.speechCueMs == null ? null : { startMs: margin, endMs: this.speechCueMs - margin },
        speaking: this.speechCueMs == null ? null : { startMs: this.speechCueMs + margin, endMs: durationMs - margin }
      };
    }
    this.publish('captured', { outcome: captureOutcome({ guidedSegments: this.segments, stopReason, durationMs }) });
    this.dispose();
    return this.segments || null;
  }

  cancel() {
    this.publish('cancelled');
    this.dispose();
  }

  dispose() {
    this.closed = true;
    this.timers.forEach(clearTimeout); this.timers.clear();
    this.unsubscribeLevel?.(); this.unsubscribeLevel = null;
    this.releasePreparationTracks?.(); this.releasePreparationTracks = null;
    this.resolvePreparation?.(false); this.resolvePreparation = null;
    if (this.onVisibility) globalThis.document?.removeEventListener?.('visibilitychange', this.onVisibility);
  }
}
