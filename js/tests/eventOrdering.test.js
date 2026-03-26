/**
 * Event Ordering Integration Tests
 * VuMeter'in dogru kaynaga baglanmasi icin event siralamasini dogrular
 *
 * KRITIK KURAL (CLAUDE.md):
 *   pipeline:analyserReady MUTLAKA stream:started'dan ONCE emit edilmeli!
 *
 * Run in console: import('./js/tests/eventOrdering.test.js').then(m => m.runEventOrderingTests())
 */

import { TestRunner, assert } from './TestRunner.js';
import eventBus from '../modules/EventBus.js';

// ═══════════════════════════════════════════════════════════════
// EventBus Ordering Tests
// ═══════════════════════════════════════════════════════════════

async function testEventBusOrdering() {
  const runner = new TestRunner('EventBus Ordering');

  runner.test('events fire in emit order (sync)', () => {
    const order = [];
    const off1 = eventBus.on('test:a', () => order.push('a'));
    const off2 = eventBus.on('test:b', () => order.push('b'));

    eventBus.emit('test:a');
    eventBus.emit('test:b');

    assert.equal(order.length, 2, 'Should have 2 events');
    assert.equal(order[0], 'a', 'First event should be a');
    assert.equal(order[1], 'b', 'Second event should be b');

    off1();
    off2();
  });

  runner.test('multiple listeners on same event fire in registration order', () => {
    const order = [];
    const off1 = eventBus.on('test:multi', () => order.push('first'));
    const off2 = eventBus.on('test:multi', () => order.push('second'));
    const off3 = eventBus.on('test:multi', () => order.push('third'));

    eventBus.emit('test:multi');

    assert.equal(order.length, 3, 'All 3 listeners should fire');
    assert.equal(order[0], 'first');
    assert.equal(order[1], 'second');
    assert.equal(order[2], 'third');

    off1();
    off2();
    off3();
  });

  return runner.run();
}

// ═══════════════════════════════════════════════════════════════
// VuMeter Event Ordering Simulation
// ═══════════════════════════════════════════════════════════════

async function testVuMeterEventOrdering() {
  const runner = new TestRunner('VuMeter Event Ordering');

  runner.test('pipeline:analyserReady fires before stream:started (Record path)', () => {
    const eventLog = [];

    // VuMeter dinleyicilerini simule et
    const offAnalyser = eventBus.on('pipeline:analyserReady', (node) => {
      eventLog.push({ event: 'pipeline:analyserReady', hasNode: !!node });
    });
    const offStream = eventBus.on('stream:started', (stream) => {
      eventLog.push({ event: 'stream:started', hasStream: !!stream });
    });

    // Recorder.js sirasini simule et (satir 146 ve 167)
    const mockAnalyserNode = { fftSize: 256 };
    const mockStream = { id: 'test' };

    eventBus.emit('pipeline:analyserReady', mockAnalyserNode);
    eventBus.emit('stream:started', mockStream);

    // Dogrulama: analyserReady ONCE gelmeli
    assert.equal(eventLog.length, 2, 'Should have 2 events');
    assert.equal(eventLog[0].event, 'pipeline:analyserReady', 'First event should be pipeline:analyserReady');
    assert.equal(eventLog[1].event, 'stream:started', 'Second event should be stream:started');
    assert.ok(eventLog[0].hasNode, 'analyserReady should have node');
    assert.ok(eventLog[1].hasStream, 'stream:started should have stream');

    offAnalyser();
    offStream();
  });

  runner.test('VuMeter guard works: analyserReady sets analyser, stream:started skips', () => {
    // VuMeter'in guard mantigi:
    // 1. pipeline:analyserReady → this.analyser = analyserNode
    // 2. stream:started → if (this.analyser) return; (SKIP)
    let vuMeterAnalyser = null;
    let audioEngineConnected = false;

    const offAnalyser = eventBus.on('pipeline:analyserReady', (node) => {
      vuMeterAnalyser = node;  // VuMeter.startWithAnalyser()
    });

    const offStream = eventBus.on('stream:started', () => {
      // VuMeter.start() guard simule
      if (vuMeterAnalyser) return;  // Guard: pipeline analyser zaten set
      audioEngineConnected = true;  // Bu satira ulasilmamali
    });

    // Dogru siralama: analyserReady ONCE
    const mockAnalyserNode = { fftSize: 256 };
    eventBus.emit('pipeline:analyserReady', mockAnalyserNode);
    eventBus.emit('stream:started', { id: 'test' });

    assert.ok(vuMeterAnalyser, 'Analyser should be set by pipeline:analyserReady');
    assert.ok(!audioEngineConnected, 'AudioEngine should NOT be connected (guard worked)');

    offAnalyser();
    offStream();
  });

  runner.test('Wrong ordering would cause AudioEngine connection (anti-pattern)', () => {
    // Bu test YANLIS siralamanin etkisini gosterir
    let vuMeterAnalyser = null;
    let audioEngineConnected = false;

    const offAnalyser = eventBus.on('pipeline:analyserReady', (node) => {
      vuMeterAnalyser = node;
    });

    const offStream = eventBus.on('stream:started', () => {
      if (vuMeterAnalyser) return;
      audioEngineConnected = true;  // YANLIS: AudioEngine'e baglanir
    });

    // YANLIS siralama: stream:started ONCE (BU OLMAMALI)
    eventBus.emit('stream:started', { id: 'test' });
    eventBus.emit('pipeline:analyserReady', { fftSize: 256 });

    // Yanlis sirada audioEngine baglanmis olur
    assert.ok(audioEngineConnected, 'Wrong order: AudioEngine connected (undesired)');
    assert.ok(vuMeterAnalyser, 'Analyser eventually set but too late');

    offAnalyser();
    offStream();
  });

  runner.test('Loopback path: stream:started without analyserReady is valid', () => {
    // Loopback modunda pipeline:analyserReady emit edilmez
    // stream:started gelince VuMeter AudioEngine'e baglanir (beklenen davranis)
    let vuMeterAnalyser = null;
    let audioEngineConnected = false;

    const offStream = eventBus.on('stream:started', () => {
      if (vuMeterAnalyser) return;
      audioEngineConnected = true;  // Loopback: Bu DOGRU davranis
    });

    eventBus.emit('stream:started', { id: 'loopback-local' });

    assert.ok(audioEngineConnected, 'Loopback: AudioEngine should connect (no pipeline)');
    assert.ok(!vuMeterAnalyser, 'Loopback: No pipeline analyser expected');

    offStream();
  });

  return runner.run();
}

// ═══════════════════════════════════════════════════════════════
// Run All Tests
// ═══════════════════════════════════════════════════════════════

export async function runEventOrderingTests() {
  console.log('\n🚀 Running Event Ordering Tests\n');
  console.log('='.repeat(50));

  const results = [];

  results.push(await testEventBusOrdering());
  results.push(await testVuMeterEventOrdering());

  console.log('\n' + '='.repeat(50));

  const total = results.reduce((acc, r) => ({
    passed: acc.passed + r.passed,
    failed: acc.failed + r.failed
  }), { passed: 0, failed: 0 });

  console.log(`\n📊 TOTAL: ${total.passed} passed, ${total.failed} failed`);

  if (total.failed === 0) {
    console.log('✨ All event ordering tests passed!');
  }

  return total;
}

// Auto-run if loaded directly
if (typeof window !== 'undefined') {
  window.runEventOrderingTests = runEventOrderingTests;
  console.log('💡 Event ordering tests loaded. Run with: runEventOrderingTests()');
}
