import test from 'node:test';
import assert from 'node:assert/strict';
import VuMeter from '../modules/VuMeter.js';
import { VU_METER } from '../modules/constants.js';

const style = () => ({ setProperty(name, value) { this[name] = value; } });

function channel() {
  const attributes = new Map();
  return {
    bar: { style: style(), dataset: {}, parentElement: { setAttribute: (name, value) => attributes.set(name, value) } },
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
  meter.activityBarEl = { style: style() };
  meter.activityStatusEl = { style: style(), dataset: {}, textContent: '' };
  meter._renderActivity(null);
  assert.equal(meter.activityStatusEl.textContent, 'Not measuring yet');
  meter._renderActivity(0);
  assert.equal(meter.activityStatusEl.textContent, 'No sound detected — speak normally');
  for (const level of [50, 70, 90]) {
    meter._renderActivity(level, 'detected');
    assert.equal(meter.activityStatusEl.textContent, 'Sound detected');
    assert.equal(meter.activityBarEl.style.width, `${level}%`);
  }
  meter._renderActivity(0);
  assert.equal(meter.activityStatusEl.textContent, 'No sound detected — speak normally');
  meter._renderActivity(null);
  assert.equal(meter.activityStatusEl.textContent, 'Not measuring yet');
  assert.equal(meter.activityBarEl.style.width, '0%');
});

test('gain colors follow sampled peaks, hold brief overloads, and share the preparation presence threshold', t => {
  let now = 100;
  t.mock.method(performance, 'now', () => now);
  const meter = Object.create(VuMeter.prototype), view = channel();
  for (const [db, state] of [[-70, 'waiting'], [-20, 'detected'], [-3, 'high'], [0, 'clipping']]) {
    now += 1500;
    const result = render(meter, view, 10 ** (db / 20));
    assert.equal(result.signalState, state);
    assert.equal(view.bar.dataset.state, state);
  }
  now += 10;
  assert.equal(render(meter, view, 0).signalState, 'clipping');
  now += VU_METER.PEAK_HOLD_TIME_MS;
  assert.equal(render(meter, view, 0).signalState, 'waiting');
  meter.activityStatusEl = { style: style(), dataset: {}, textContent: '' };
  meter.guideStage = 'quiet'; meter._renderActivity(0, 'waiting');
  assert.match(meter.activityStatusEl.textContent, /stay quiet/);
  meter.guideStage = 'speak'; meter._renderActivity(0, 'waiting');
  assert.match(meter.activityStatusEl.textContent, /speak normally/);
});

test('color follows continuous levels inside a single warning state and all local indicators share it', t => {
  let now = 100;
  t.mock.method(performance, 'now', () => now);
  const meter = Object.create(VuMeter.prototype), view = channel(), colors = new Set();
  meter.activityBarEl = { style: style(), dataset: {} };
  meter.activityStatusEl = { style: style(), dataset: {} };
  meter.dotEl = { style: style() };
  for (let db = -50; db < -7; db += 0.1) {
    now += 100;
    const result = render(meter, view, 10 ** (db / 20));
    assert.equal(result.signalState, 'detected');
    meter._renderActivity(result.activityLevel, result.signalState, result.color);
    assert.equal(result.activityLevel, (view.state.colorDb - VU_METER.MIN_DB) / -VU_METER.MIN_DB * 100);
    for (const element of [meter.activityBarEl, meter.activityStatusEl, meter.dotEl]) {
      assert.equal(element.style['--signal-color'], view.bar.style['--signal-color']);
    }
    colors.add(result.color);
  }
  assert(colors.size > 400, 'a steady sweep produces intermediate colors, not three status colors');
});

test('peak color rises and falls smoothly without delaying overload detection and is frame-rate independent', t => {
  let now = 100;
  t.mock.method(performance, 'now', () => now);
  const meter = Object.create(VuMeter.prototype), view = channel();
  view.state.colorDb = -30; view.state.lastRenderTime = now;
  now += 16;
  const overload = render(meter, view, 1);
  assert.equal(overload.rawDb, 0);
  assert.equal(overload.isClipping, true, 'measurement and warning remain immediate');
  assert(view.state.colorDb > -30 && view.state.colorDb < 0);
  now += 800; render(meter, view, 0);
  assert.equal(view.bar.dataset.state, 'clipping', 'warning text remains available');
  assert(view.state.colorDb < -90, 'old clipping never pins the live color or fill at full scale');
  now += 250; render(meter, view, 0);
  assert(view.state.colorDb < -0.51 && view.state.colorDb > VU_METER.MIN_DB, 'release passes through intermediate hues');

  const settle = step => {
    now = 100;
    const frame = channel(); frame.state.colorDb = -40; frame.state.lastRenderTime = now;
    for (let elapsed = step; elapsed <= 300; elapsed += step) {
      now += step; render(meter, frame, 0.1);
    }
    return frame.state.colorDb;
  };
  assert(Math.abs(settle(10) - settle(20)) < 1e-9, 'time, not frame count, controls the envelope');
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
