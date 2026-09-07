import { DeepAnalysisEngine } from '../modules/DeepAnalysisEngine.js';
import { DEEP_ANALYSIS } from '../modules/constants.js';
import { runOpusFinalizationChecks } from './opus-audit-browser.js';

const output = document.getElementById('results');
const lines = [];
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const near = (actual, expected, tolerance = 0.15) => assert(Number.isFinite(actual)
  && Math.abs(actual - expected) <= tolerance, `Expected ${expected}, received ${actual}`);

function wave({ rate = 48000, seconds = 4, amplitude = 10 ** (-23 / 20), opposite = false, silent = false } = {}) {
  const samples = Math.round(rate * seconds), channelCount = 2;
  const bytes = new ArrayBuffer(44 + samples * channelCount * 2), view = new DataView(bytes);
  const text = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  text(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channelCount, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * channelCount * 2, true);
  view.setUint16(32, channelCount * 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, bytes.byteLength - 44, true);
  for (let frame = 0; frame < samples; frame++) {
    const sample = silent ? 0 : Math.round(amplitude * Math.sin(2 * Math.PI * 1000 * frame / rate) * 32767);
    view.setInt16(44 + frame * 4, sample, true);
    view.setInt16(46 + frame * 4, opposite ? -sample : sample, true);
  }
  return new Blob([bytes], { type: 'audio/wav' });
}

const engine = new DeepAnalysisEngine();
try {
  for (const rate of [16000, 24000, 44100, 48000]) {
    const result = await engine.analyze(wave({ rate, opposite: true }), { runId: `stereo-${rate}`, source: 'record' });
    assert(result.status === 'ready', `${rate} Hz decode/worker failed: ${result.reason}`);
    assert(result.audioMetrics.runId === `stereo-${rate}`, 'Wrong run identity');
    assert(result.audioMetrics.channels.length === 2, 'Stereo channels lost');
    assert(result.source.sampleRateBasis === 'decoded-pcm', 'Missing decoded-rate qualification');
    near(result.audioMetrics.lufs.integrated, -23);
    near(result.audioMetrics.durationMs, 4000, 1);
    assert(result.audioMetrics.snr.estimatedDb === null && result.audioMetrics.noiseFloor.estimatedDb === null,
      'Uncontrolled tone was assigned noise or SNR');
    assert(result.frequencyResponse.bins.some(bin => bin.db > -15), 'Narrow spectral tone disappeared');
    lines.push(`PASS: ${rate} Hz opposite-phase stereo WAV → ${result.source.sampleRate} Hz decoded PCM, ${result.audioMetrics.lufs.integrated} LUFS`);
  }
  const silence = await engine.analyze(wave({ silent: true }), { runId: 'silence' });
  assert(silence.status === 'ready', 'Silent WAV analysis failed');
  near(silence.audioMetrics.silence.totalDurationMs, 4000, 1);
  assert(silence.audioMetrics.dropouts.count === null, 'Silence was diagnosed as dropout');
  assert(silence.audioMetrics.lufs.integrated === null, 'Digital silence produced a loudness value');
  assert(silence.frequencyResponse.bins.every(bin => Number.isFinite(bin.db)), 'Non-finite spectrum');
  lines.push('PASS: digital silence stays distinct from missing samples and unknown loudness');
  const clean = await engine.analyze(wave({ amplitude: 0.96 }), { runId: 'headroom' });
  assert(clean.status === 'ready', 'Headroom analysis failed');
  assert(clean.audioMetrics.clipping.saturatedSamples === 0, 'Clean 0.96-peak tone reported saturation');
  assert(clean.audioMetrics.headroom.nearPeakRate > 0, 'Low headroom was not measured');
  lines.push('PASS: clean near-full-scale tone has low headroom without sample saturation');
  const previousLimit = DEEP_ANALYSIS.MAX_DURATION_SEC;
  try {
    DEEP_ANALYSIS.MAX_DURATION_SEC = 3;
    const prefix = await engine.analyze(wave({ seconds: 4 }), { runId: 'prefix' });
    assert(prefix.status === 'ready' && prefix.source.truncated, 'Prefix was not labeled');
    near(prefix.source.durationSec, 4); near(prefix.source.analyzedDurationSec, 3);
    lines.push('PASS: capped analysis labels analyzed prefix and complete decoded duration separately');
  } finally { DEEP_ANALYSIS.MAX_DURATION_SEC = previousLimit; }
  const bad = await engine.analyze(new Blob(['invalid audio']), { runId: 'invalid' });
  assert(bad.status === 'failed' && bad.audioMetrics === null, 'Decode failure manufactured audio evidence');
  lines.push('PASS: decode failure returns unavailable evidence');
  const opusChecks = await runOpusFinalizationChecks();
  lines.push(`PASS: ${opusChecks} real WASM Opus finalizations preserve decoded duration, channels and start/tail tones`);
  output.dataset.status = 'passed';
  output.textContent = `${lines.join('\n')}\n\n${lines.length} checks passed.`;
} catch (error) {
  output.dataset.status = 'failed';
  output.textContent = `${lines.join('\n')}\nFAIL: ${error.stack || error.message}`;
} finally { engine.destroy(); }
