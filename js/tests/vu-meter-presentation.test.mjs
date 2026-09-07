import test from 'node:test';
import assert from 'node:assert/strict';
import VuMeter from '../modules/VuMeter.js';
import { VU_METER } from '../modules/constants.js';

function channel() {
  const attributes = new Map();
  return {
    bar: { style: {}, parentElement: { setAttribute: (name, value) => attributes.set(name, value) } },
    peak: { hidden: true, style: {} },
    reading: { textContent: '—' },
    state: { smoothedRms: 0, lastRenderTime: 0 },
    attributes,
    held: 0,
    holdTime: 0
  };
}

function render(meter, view, amplitude) {
  const data = new Float32Array(256);
  const analyser = { getFloatTimeDomainData: buffer => buffer.fill(amplitude) };
  const result = meter._renderMeter(analyser, data, view.bar, view.peak,
    view.held, view.holdTime, 400, view.state, view.reading);
  view.held = result.peakLevel;
  view.holdTime = result.peakHoldTime;
  return result;
}

test('activity text distinguishes capture from idle and reports presence without grading sound quality', () => {
  const meter = Object.create(VuMeter.prototype);
  meter.activityBarEl = { style: {} };
  meter.activityStatusEl = { dataset: {}, textContent: '' };
  meter._renderActivity(null);
  assert.equal(meter.activityStatusEl.textContent, 'Ready to check');
  meter._renderActivity(0);
  assert.equal(meter.activityStatusEl.textContent, 'Waiting for sound');
  for (const level of [VU_METER.DOT_ACTIVE_THRESHOLD + 1, 50, 100]) {
    meter._renderActivity(level);
    assert.equal(meter.activityStatusEl.textContent, 'Sound detected');
    assert.equal(meter.activityBarEl.style.width, `${level}%`);
  }
  meter._renderActivity(0);
  assert.equal(meter.activityStatusEl.textContent, 'Waiting for sound');
  meter._renderActivity(null);
  assert.equal(meter.activityStatusEl.textContent, 'Ready to check');
  assert.equal(meter.activityBarEl.style.width, '0%');
});

test('readout uses the same smoothed dBFS as the fill while preserving raw RMS and held level', t => {
  let now = 100;
  t.mock.method(performance, 'now', () => now);
  const meter = Object.create(VuMeter.prototype);
  const view = channel();
  const amplitude = 10 ** (-24 / 20);
  view.state.smoothedRms = amplitude;
  const first = render(meter, view, amplitude);
  assert(Math.abs(first.dB + 24) < 0.00001);
  assert(Math.abs(first.rawDb + 24) < 0.00001);
  assert(Math.abs(parseFloat(view.bar.style.width) - 75) < 0.00001);
  assert.equal(view.reading.textContent, '−24.0');
  assert.equal(view.attributes.get('aria-valuenow'), '-24.0');
  assert.equal(view.attributes.get('aria-valuetext'), '−24.0 dBFS');
  assert.equal(view.peak.hidden, false);

  now = 200;
  const quieter = render(meter, view, 0.001);
  assert(quieter.dB < first.dB, 'the continuous fill keeps responding between text updates');
  assert.equal(view.reading.textContent, '−24.0', 'text is limited to four updates per second');
  assert.equal(quieter.peakLevel, first.peakLevel, 'recent high remains held independently of the readout');
  now = 400;
  const next = render(meter, view, 0.001);
  assert.equal(view.reading.textContent, next.dB.toFixed(1).replace('-', '−'));
  assert.equal(view.attributes.get('aria-valuenow'), next.dB.toFixed(1));
});

test('silence and sub-threshold samples show a bound, and full scale keeps the marker inside the track', t => {
  let now = 100;
  t.mock.method(performance, 'now', () => now);
  const meter = Object.create(VuMeter.prototype);
  const view = channel();
  for (const amplitude of [0, VU_METER.RMS_THRESHOLD / 2]) {
    now += 300;
    render(meter, view, amplitude);
    assert.equal(view.reading.textContent, '≤ −80');
    assert.equal(view.peak.hidden, true);
    assert.equal(view.attributes.get('aria-valuenow'), String(VU_METER.MIN_DB.toFixed(1)));
  }
  now += 300;
  view.state.smoothedRms = 1;
  render(meter, view, 1);
  assert.equal(view.reading.textContent, '0.0');
  assert.equal(view.bar.style.width, '100%');
  assert.equal(view.peak.style.transform, `translateX(${400 - VU_METER.PEAK_WIDTH}px)`);
});

test('stopping either channel clears its visible and accessible value; the next run starts fresh', t => {
  t.mock.method(performance, 'now', () => 100);
  const meter = Object.create(VuMeter.prototype);
  const local = channel(), remote = channel();
  render(meter, local, 0.1);
  render(meter, remote, 0.01);
  Object.assign(meter, {
    barEl: local.bar, peakEl: local.peak, readingEl: local.reading, _localMeterState: local.state,
    remoteBarEl: remote.bar, remotePeakEl: remote.peak, remoteReadingEl: remote.reading,
    _remoteMeterState: remote.state
  });
  meter.stopRemote();
  assert.equal(remote.reading.textContent, '—');
  assert.equal(remote.peak.hidden, true);
  assert.equal(remote.attributes.get('aria-valuetext'), 'Not measuring');
  assert.notEqual(local.reading.textContent, '—', 'remote teardown does not reset the microphone');
  meter.stop();
  assert.equal(local.reading.textContent, '—');
  assert.equal(local.peak.hidden, true);
  assert.equal(local.bar.style.width, '0');
  assert.equal(local.attributes.get('aria-valuenow'), String(VU_METER.MIN_DB));
  assert.equal(local.attributes.get('aria-valuetext'), 'Not measuring');
  local.state = meter._localMeterState;
  local.held = 0;
  const next = render(meter, local, 0.01);
  assert.equal(local.reading.textContent, next.dB.toFixed(1).replace('-', '−'));
});
