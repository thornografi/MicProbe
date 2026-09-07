#!/usr/bin/env python3
"""Independent reference measurement for MicProbe reports.

Measures a recorded file with ffmpeg (ebur128 / astats) and numpy, then compares the
values against the report JSON MicProbe produced for the same file.

  python scripts/reference-audio-metrics.py --selftest
  python scripts/reference-audio-metrics.py --manifest .tmp/real-capture/<date>/manifest.json
  python scripts/reference-audio-metrics.py --audio rec.wav --report rec.report.json --label R1

Manifest schema: {"layer": str, "sourceWav": str|null, "entries": [{"id", "profile", "scenario",
"audio", "report", "expectFindings": [..], "notes"}]}. Paths are relative to the manifest.
The report file may be the raw report or a wrapper {"report": ..., "evaluation": ...}.

Requires ffmpeg/ffprobe (default C:\\Tools\\ffmpeg\\bin), numpy and scipy. It never
modifies MicProbe code; deviations are reported, not fixed.
"""
import argparse
import json
import math
import os
import re
import subprocess
import sys
from datetime import datetime, timezone

import numpy as np
from scipy import signal as sps
from scipy.io import wavfile

FFMPEG_DIR = os.environ.get('MICPROBE_FFMPEG_DIR', r'C:\Tools\ffmpeg\bin')
FFMPEG = os.path.join(FFMPEG_DIR, 'ffmpeg.exe')
FFPROBE = os.path.join(FFMPEG_DIR, 'ffprobe.exe')

# Mirrors js/modules/constants.js (QUALITY / VU_METER / DEEP_ANALYSIS) — read, not imported.
BLOCK_MS = 10
SILENCE_DB = -55
WEAK_SIGNAL_DB = -45
LEVEL_PERCENTILE = 10
SATURATION = 1 - 1 / 32768
NEAR_PEAK = 10 ** (-0.5 / 20)
MAX_DURATION_SEC = 30
CEILING_PERCENTILE = 99
CEILING_WINDOW_DB = 1.0
FLAT_STEP_DB = -60
DUAL_MONO_MAX_DIFF_DB = -60
# ITU-R BS.1770-4 Annex 2 Table 2: 4x over-sampling polyphase FIR, 12 taps per phase.
TRUE_PEAK_PHASES = np.array([
    [0.0017089843750, 0.0109863281250, -0.0196533203125, 0.0332031250000, -0.0594482421875, 0.1373291015625,
     0.9721679687500, -0.1022949218750, 0.0476074218750, -0.0266113281250, 0.0148925781250, -0.0083007812500],
    [-0.0291748046875, 0.0292968750000, -0.0517578125000, 0.0891113281250, -0.1665039062500, 0.4650878906250,
     0.7797851562500, -0.2003173828125, 0.1015625000000, -0.0582275390625, 0.0330810546875, -0.0189208984375],
    [-0.0189208984375, 0.0330810546875, -0.0582275390625, 0.1015625000000, -0.2003173828125, 0.7797851562500,
     0.4650878906250, -0.1665039062500, 0.0891113281250, -0.0517578125000, 0.0292968750000, -0.0291748046875],
    [-0.0083007812500, 0.0148925781250, -0.0266113281250, 0.0476074218750, -0.1022949218750, 0.9721679687500,
     0.1373291015625, -0.0594482421875, 0.0332031250000, -0.0196533203125, 0.0109863281250, 0.0017089843750]])
FFT_SIZE = 4096
HOP_SIZE = 2048
BANDS = {'subBass': (0, 250), 'lowMid': (250, 2000), 'highMid': (2000, 6000), 'presence': (6000, 20000)}

TOL = {  # comparison tolerances from the approved plan
    'lufs.integrated': 0.1, 'rms.wav': 0.05, 'rms.lossy': 0.3, 'peak.wav': 0.05, 'peak.lossy': 0.3,
    'maxBlockRms': 0.1, 'silenceMs': 20, 'percentile': 0.2, 'band': 0.5, 'durationMs': 10, 'bitratePct': 15,
    # lossy files are decoded by two different Opus decoders (Chrome vs ffmpeg); block-level spread and the
    # highest band carry the decoder difference, so they get a wider window than PCM.
    'percentile.lossy': 0.5, 'band.lossy': 1.0,
}


# ----------------------------------------------------------------------------- ffmpeg helpers
def run(cmd):
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='replace')
    return proc.returncode, proc.stdout, proc.stderr


def ffprobe(path):
    code, out, err = run([FFPROBE, '-v', 'error', '-show_streams', '-show_format', '-of', 'json', path])
    if code:
        raise RuntimeError(f'ffprobe failed for {path}: {err.strip()}')
    info = json.loads(out)
    stream = next((s for s in info.get('streams', []) if s.get('codec_type') == 'audio'), {})
    fmt = info.get('format', {})
    duration = float(stream.get('duration') or fmt.get('duration') or 'nan')
    return {
        'codec': stream.get('codec_name'), 'sampleRate': int(stream.get('sample_rate') or 0),
        'channels': int(stream.get('channels') or 0), 'durationSec': duration,
        'bitRate': int(stream.get('bit_rate') or fmt.get('bit_rate') or 0),
        'formatName': fmt.get('format_name'), 'sizeBytes': int(fmt.get('size') or 0),
    }


def decode(path, channels, rate=None):
    cmd = [FFMPEG, '-v', 'error', '-i', path, '-map', 'a:0', '-vn']
    if rate:
        cmd += ['-ar', str(rate)]
    cmd += ['-f', 'f32le', '-acodec', 'pcm_f32le', '-']
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode:
        raise RuntimeError(f'ffmpeg decode failed for {path}: {proc.stderr.decode(errors="replace").strip()}')
    pcm = np.frombuffer(proc.stdout, dtype=np.float32)
    frames = pcm.size // channels
    return pcm[:frames * channels].reshape(frames, channels)


def ffmpeg_ebur128(path, max_sec=MAX_DURATION_SEC):
    code, out, err = run([FFMPEG, '-nostats', '-i', path, '-t', str(max_sec), '-map', 'a:0',
                          '-af', 'ebur128=peak=true', '-f', 'null', '-'])
    summary = err[err.rfind('Summary:'):] if 'Summary:' in err else ''
    def grab(pattern):
        match = re.search(pattern, summary)
        if not match:
            return None
        value = match.group(1)
        return float('-inf') if value == '-inf' else float(value)
    return {'integrated': grab(r'I:\s+(-?[\d.]+|-inf) LUFS'), 'threshold': grab(r'Threshold:\s+(-?[\d.]+|-inf) LUFS'),
            'lra': grab(r'LRA:\s+(-?[\d.]+|-inf) LU'), 'truePeakDb': grab(r'Peak:\s+(-?[\d.]+|-inf) dBFS')}


def ffmpeg_astats(path, max_sec=MAX_DURATION_SEC):
    code, out, err = run([FFMPEG, '-nostats', '-i', path, '-t', str(max_sec), '-map', 'a:0', '-af',
                          'aformat=sample_fmts=flt,astats=measure_perchannel=Peak_level+RMS_level'
                          ':measure_overall=Peak_level+RMS_level', '-f', 'null', '-'])
    result = {'channels': [], 'overall': {}}
    current = None
    for line in err.splitlines():
        line = re.sub(r'^\[[^\]]*\]\s*', '', line).strip()
        if line.startswith('Channel:'):
            current = {}
            result['channels'].append(current)
        elif line.startswith('Overall'):
            current = result['overall']
        elif current is not None and ':' in line:
            key, _, value = line.partition(':')
            value = value.strip()
            if key.strip() in ('Peak level dB', 'RMS level dB'):
                current[key.strip()] = float('-inf') if value == '-inf' else float(value)
    return result


# ----------------------------------------------------------------------------- MicProbe definitions in numpy
def db(power):
    return round(max(-180.0, 10 * math.log10(max(float(power), 1e-18))), 2)


def k_weighting(sample_rate):
    """BS.1770 pre-filter + RLB filter; 48 kHz table constants otherwise bilinear design."""
    if sample_rate == 48000:
        pre = ([1.53512485958697, -2.69169618940638, 1.19839281085285], [1, -1.69065929318241, 0.73248077421585])
        rlb = ([1.0, -2.0, 1.0], [1, -1.99004745483398, 0.99007225036621])
        return pre, rlb
    def shelf(f0, gain_db, q):
        k = math.tan(math.pi * f0 / sample_rate)
        vh = 10 ** (gain_db / 20)
        vb = vh ** 0.499666774155
        a0 = 1 + k / q + k * k
        b = [(vh + vb * k / q + k * k) / a0, 2 * (k * k - vh) / a0, (vh - vb * k / q + k * k) / a0]
        a = [1, 2 * (k * k - 1) / a0, (1 - k / q + k * k) / a0]
        return b, a
    def highpass(f0, q):
        k = math.tan(math.pi * f0 / sample_rate)
        a0 = 1 + k / q + k * k
        return [1, -2, 1], [1, 2 * (k * k - 1) / a0, (1 - k / q + k * k) / a0]
    return shelf(1681.974450955533, 3.999843853973347, 0.7071752369554196), highpass(38.13547087602444, 0.5003270373238773)


def lufs_metrics(pcm, sample_rate):
    """Integrated (gated) plus last momentary / short-term window exactly like utils/lufs.js."""
    frames, channels = pcm.shape
    if channels > 2:
        return {'status': 'unavailable', 'integrated': None, 'momentary': None, 'shortTerm': None}
    (pb, pa), (rb, ra) = k_weighting(sample_rate)
    power = np.zeros(frames, dtype=np.float64)
    for ch in range(channels):
        filtered = sps.lfilter(rb, ra, sps.lfilter(pb, pa, pcm[:, ch].astype(np.float64)))
        power += filtered * filtered  # channel weights are all 1.0 (L/R); powers are summed
    momentary_size, hop, short_size = round(0.4 * sample_rate), round(0.1 * sample_rate), round(3 * sample_rate)
    csum = np.concatenate(([0.0], np.cumsum(power)))
    def window_means(size):
        ends = np.arange(size, frames + 1, hop)  # window ends aligned to the hop grid from the start
        return (csum[ends] - csum[ends - size]) / size if ends.size else np.array([])
    blocks = window_means(momentary_size)
    short = window_means(short_size)
    def to_lufs(value):
        return round(-0.691 + 10 * math.log10(value), 2) if value > 1e-18 else None
    integrated = None
    if blocks.size:
        above = blocks[blocks > 10 ** ((-70 + 0.691) / 10)]
        if above.size:
            gated = above[above > above.mean() / 10]
            integrated = to_lufs(gated.mean())
    layout, _ = channel_layout(pcm, float(np.abs(pcm).max()))
    mono = None if integrated is None else integrated if layout == 'mono' else round(integrated - 3.01, 2) if layout == 'dual-mono' else None
    return {'status': 'measured' if blocks.size else 'unavailable', 'integrated': integrated,
            'momentary': to_lufs(blocks[-1]) if blocks.size else None,
            'shortTerm': to_lufs(short[-1]) if short.size else None, 'blockCount': int(blocks.size),
            'integratedMonoEquivalent': mono, 'channelLayout': layout}


def true_peak_db(pcm, sample_rate, sample_peak):
    """BS.1770-4 Annex 2 true peak: maximum over the polyphase FIR outputs (4x below 96 kHz, 2x below 192 kHz)."""
    phases = TRUE_PEAK_PHASES if sample_rate < 96000 else TRUE_PEAK_PHASES[[0, 2]] if sample_rate < 192000 else None
    if phases is None:
        return db(sample_peak ** 2)
    peak = sample_peak
    for ch in range(pcm.shape[1]):
        x = pcm[:, ch].astype(np.float64)
        for taps in phases:
            # numpy convolve applies taps[k] to x[i-k], identical to the worker's causal sum
            peak = max(peak, float(np.abs(np.convolve(x, taps, mode='full')[:x.size]).max()))
    return db(peak ** 2)


def ceiling_metrics(pcm, peak):
    """Ceiling = 99th percentile of |x| (same 4096-bin histogram as the worker); dwell within 1 dB of it; exact plateaus."""
    frames, channels = pcm.shape
    total = frames * channels
    if peak <= 0:
        return {'nearCeilingRate': 0.0, 'flatTopRate': 0.0, 'ceilingDb': None, 'status': 'unavailable'}
    abs_pcm = np.abs(pcm)
    bins = np.minimum(4095, np.floor(abs_pcm / peak * 4095)).astype(np.int64)
    counts = np.bincount(bins.ravel(), minlength=4096)
    cumulative = np.cumsum(counts)
    bin_index = int(np.argmax(cumulative >= total * CEILING_PERCENTILE / 100))
    ceiling = (bin_index + 1) / 4095 * peak
    near = abs_pcm >= ceiling * 10 ** (-CEILING_WINDOW_DB / 20)
    flat = np.zeros_like(near)
    flat[1:] = np.abs(np.diff(pcm.astype(np.float64), axis=0)) <= peak * 10 ** (FLAT_STEP_DB / 20)
    return {'nearCeilingRate': float(np.count_nonzero(near)) / total, 'flatTopRate': float(np.count_nonzero(near & flat)) / total,
            'ceilingDb': db(ceiling * ceiling), 'status': 'measured'}


def channel_layout(pcm, peak):
    frames, channels = pcm.shape
    if channels == 1:
        return 'mono', None
    diff = float(np.abs(pcm[:, 1:].astype(np.float64) - pcm[:, :1].astype(np.float64)).max()) if peak > 0 else 0.0
    identical = peak > 0 and diff <= peak * 10 ** (DUAL_MONO_MAX_DIFF_DB / 20)
    layout = 'dual-mono' if identical else 'stereo' if channels == 2 else 'multichannel'
    return layout, (db((max(diff, 1e-9) / peak) ** 2) if peak > 0 else None)


def pcm_metrics(pcm, sample_rate):
    """Replicates js/modules/utils/pcmAnalysis.js analyzePcm() on decoded float PCM."""
    frames, channels = pcm.shape
    block = max(1, round(sample_rate * BLOCK_MS / 1000))
    abs_pcm = np.abs(pcm)
    square = pcm.astype(np.float64) ** 2
    frame_sq = square.sum(axis=1)                      # pooled power per frame
    total_sq = float(frame_sq.sum())
    peak = float(abs_pcm.max())
    # Non-overlapping 10 ms blocks; the final partial block is normalised by its own length.
    edges = list(range(0, frames, block)) + [frames]
    block_db = []
    silence_frames = silence_events = weak_frames = 0
    previous_silent = False
    for start, end in zip(edges[:-1], edges[1:]):
        value = db(frame_sq[start:end].sum() / ((end - start) * channels))
        block_db.append(value)
        silent = value < SILENCE_DB
        if silent:
            silence_frames += end - start
            if not previous_silent:
                silence_events += 1
        if value < WEAK_SIGNAL_DB:
            weak_frames += end - start
        previous_silent = silent
    levels = np.array(block_db)
    ordered = np.sort(levels)
    def percentile(p):
        return float(ordered[min(ordered.size - 1, math.floor((ordered.size - 1) * p / 100))])
    p10, p90 = percentile(LEVEL_PERCENTILE), percentile(100 - LEVEL_PERCENTILE)
    # Every complete 10 ms window with a one-sample hop (sliding maximum).
    if frames >= block:
        csum = np.concatenate(([0.0], np.cumsum(frame_sq)))
        max_window = float((csum[block:] - csum[:-block]).max())
        max_block_db = db(max_window / (block * channels))
    else:
        max_block_db = None
    layout, layout_diff = channel_layout(pcm, peak)
    saturated_mask = abs_pcm >= SATURATION
    saturated_frame = saturated_mask.any(axis=1)
    events = int(np.count_nonzero(saturated_frame & ~np.concatenate(([False], saturated_frame[:-1]))))
    total_samples = frames * channels
    return {
        'sampleCount': frames, 'durationMs': round(frames / sample_rate * 1000, 2),
        'channels': [{'peakDb': db(float(abs_pcm[:, ch].max()) ** 2), 'rmsDb': db(square[:, ch].sum() / frames),
                      'saturatedSamples': int(saturated_mask[:, ch].sum())} for ch in range(channels)],
        'rmsDb': db(total_sq / total_samples), 'peakDb': db(peak * peak), 'maxBlockRmsDb': max_block_db,
        'lowLevelPercentileDb': p10, 'dynamicRangeDb': round(p90 - p10, 2),
        'stabilityDbStdDev': round(float(np.sqrt(np.mean((levels - levels.mean()) ** 2))), 2),
        'clipping': {'saturatedSamples': int(saturated_mask.sum()), 'rate': float(saturated_mask.sum()) / total_samples,
                     'eventCount': events},
        'headroom': {'nearPeakRate': float(np.count_nonzero(abs_pcm >= NEAR_PEAK)) / total_samples, 'db': -db(peak * peak)},
        'flatTopRatio': float(np.count_nonzero(abs_pcm >= peak * 10 ** (-1 / 20))) / total_samples if peak > 0 else 0.0,
        'silence': {'count': silence_events, 'totalDurationMs': round(silence_frames / sample_rate * 1000, 2)},
        'weakSignal': {'frames': weak_frames, 'rate': weak_frames / frames},
        'lufs': lufs_metrics(pcm, sample_rate),
        'crestFactorDb': round(db(peak * peak) - db(total_sq / total_samples), 2),
        'truePeakDb': true_peak_db(pcm, sample_rate, peak),
        'ceiling': ceiling_metrics(pcm, peak),
        'channelLayout': layout,
        'channelMaxDifferenceDb': layout_diff,
    }


def spectrum_metrics(pcm, sample_rate):
    """Welch channel-power average with the worker's symmetric Hann window and band definitions."""
    frames, channels = pcm.shape
    fft_size = FFT_SIZE
    while fft_size > frames:
        fft_size >>= 1
    hop = max(1, min(HOP_SIZE, fft_size >> 1))
    if fft_size < 2 or frames < fft_size:
        return None
    window = np.hanning(fft_size)  # 0.5 - 0.5 cos(2*pi*i/(N-1)), identical to the worker
    half = fft_size // 2
    total_frames = (frames - fft_size) // hop + 1
    power = np.zeros(half, dtype=np.float64)
    for ch in range(channels):
        data = pcm[:, ch].astype(np.float64)
        starts = np.arange(0, total_frames * hop, hop)
        segments = np.lib.stride_tricks.as_strided(data, shape=(total_frames, fft_size),
                                                   strides=(data.strides[0] * hop, data.strides[0]))
        spectra = np.fft.rfft(segments * window, axis=1)[:, :half]
        power += (spectra.real ** 2 + spectra.imag ** 2).sum(axis=0)
    p_avg = power / (total_frames * channels)
    bin_width = sample_rate / fft_size
    f_max = min(sample_rate / 2, 20000)
    k_min = max(1, math.floor(20 / bin_width))
    k_max = min(half - 1, math.ceil(f_max / bin_width))
    overall = p_avg[k_min:k_max + 1]
    overall_mean = overall.mean()
    ref_power = float(overall.max())
    bands = {}
    for name, (lo_hz, hi_hz) in BANDS.items():
        lo = max(k_min, math.floor(lo_hz / bin_width))
        hi = min(k_max, math.ceil(hi_hz / bin_width))
        bands[name] = None if hi < lo or ref_power <= 1e-18 else round(
            10 * math.log10((p_avg[lo:hi + 1].mean() + 1e-30) / (overall_mean + 1e-30)), 1)
    geo = math.exp(np.log(overall + 1e-30).mean())
    flatness = round(geo / ((overall + 1e-30).mean()), 4) if ref_power > 1e-18 else None
    return {'bands': bands, 'spectralFlatness': flatness, 'frameCount': total_frames, 'fftSize': fft_size,
            'binWidthHz': round(bin_width, 2)}


def measure(path, decode_rate=None):
    probe = ffprobe(path)
    native = decode(path, probe['channels'])
    # MediaRecorder WebM carries no duration/bitrate header: derive both from the decoded stream.
    if not math.isfinite(probe['durationSec']) or probe['durationSec'] <= 0:
        probe['durationSec'] = native.shape[0] / probe['sampleRate']
        probe['durationSource'] = 'decoded-frames'
    else:
        probe['durationSource'] = 'container'
    if not probe['bitRate'] and probe['durationSec'] > 0:
        probe['bitRate'] = int(round(probe['sizeBytes'] * 8 / probe['durationSec']))
        probe['bitRateSource'] = 'size/duration'
    frames = min(native.shape[0], math.floor(MAX_DURATION_SEC * probe['sampleRate']))
    result = {'probe': probe, 'ebur128': ffmpeg_ebur128(path), 'astats': ffmpeg_astats(path),
              'native': {'sampleRate': probe['sampleRate'], 'truncated': native.shape[0] > frames}}
    native_pcm = native[:frames]
    result['native'].update(pcm_metrics(native_pcm, probe['sampleRate']))
    result['native']['spectrum'] = spectrum_metrics(native_pcm, probe['sampleRate'])
    if decode_rate and decode_rate != probe['sampleRate']:
        resampled = decode(path, probe['channels'], decode_rate)
        frames = min(resampled.shape[0], math.floor(MAX_DURATION_SEC * decode_rate))
        result['resampled'] = {'sampleRate': decode_rate, 'truncated': resampled.shape[0] > frames}
        result['resampled'].update(pcm_metrics(resampled[:frames], decode_rate))
        result['resampled']['spectrum'] = spectrum_metrics(resampled[:frames], decode_rate)
    return result



# ----------------------------------------------------------------------------- chain loss versus a known source
def chain_against_source(source_path, source_ref, audio_path, report):
    """Aligns the recording to the source WAV by cross-correlation and measures the same segment of the source.

    The report measured the recording; the aligned source segment is what went into the chain
    (fake capture device or OS audio path → browser processing → encoder). Δ = report − source.
    """
    probe = source_ref['probe']
    sr, src_channels = probe['sampleRate'], probe['channels']
    source = decode(source_path, src_channels)
    rec_probe = ffprobe(audio_path)
    rec = decode(audio_path, rec_probe['channels'], sr)
    src_mono, rec_mono = source.mean(axis=1).astype(np.float64), rec.mean(axis=1).astype(np.float64)
    if rec_mono.size < sr // 2 or src_mono.size < rec_mono.size // 2:
        return None
    corr = sps.correlate(src_mono, rec_mono, mode='full', method='fft')
    lags = sps.correlation_lags(src_mono.size, rec_mono.size, mode='full')
    lag = int(lags[int(np.argmax(corr))])
    lag = max(0, lag)
    segment = source[lag:lag + rec.shape[0]]
    length = min(segment.shape[0], rec.shape[0])
    segment, aligned_rec = segment[:length], rec[:length]
    a, b = src_mono[lag:lag + length], rec_mono[:length]
    coef = float(np.corrcoef(a, b)[0, 1]) if a.std() > 0 and b.std() > 0 else 0.0
    seg_metrics = pcm_metrics(segment, sr)
    seg_metrics['spectrum'] = spectrum_metrics(segment, sr)
    metrics = report.get('audioMetrics') or {}
    rows = [{'field': 'alignment offset (ms into source)', 'reported': None, 'reference': round(lag / sr * 1000, 1), 'delta': None},
            {'field': 'alignment correlation (1 = identical shape)', 'reported': None, 'reference': round(coef, 4), 'delta': None},
            {'field': 'compared length (s)', 'reported': round(rec.shape[0] / sr, 3), 'reference': round(length / sr, 3), 'delta': None}]
    pairs = [('chain ΔLUFS integrated', get(metrics, 'lufs', 'integrated'), seg_metrics['lufs']['integrated']),
             ('chain ΔRMS dB', get(metrics, 'signal', 'rmsDb'), seg_metrics['rmsDb']),
             ('chain Δpeak dB', get(metrics, 'signal', 'peakDb'), seg_metrics['peakDb']),
             ('chain ΔmaxBlockRms dB', get(metrics, 'signal', 'maxBlockRmsDb'), seg_metrics['maxBlockRmsDb']),
             ('chain Δsilence ms', get(metrics, 'silence', 'totalDurationMs'), seg_metrics['silence']['totalDurationMs']),
             ('chain ΔlowLevel p10 dB', get(metrics, 'lowLevel', 'percentileDb'), seg_metrics['lowLevelPercentileDb']),
             ('chain ΔdynamicRange dB', get(metrics, 'dynamicRange', 'db'), seg_metrics['dynamicRangeDb'])]
    for band in BANDS:
        pairs.append((f'chain Δ{band} dB', get(metrics, 'frequencyProfile', band), (seg_metrics['spectrum'] or {}).get('bands', {}).get(band)))
    pairs.append(('chain ΔspectralFlatness', get(report, 'deepAnalysis', 'spectralFlatness'), (seg_metrics['spectrum'] or {}).get('spectralFlatness')))
    for field, reported, reference in pairs:
        delta = round(reported - reference, 2) if isinstance(reported, (int, float)) and isinstance(reference, (int, float)) else None
        rows.append({'field': field, 'reported': reported, 'reference': reference, 'delta': delta})
    if rec_probe['channels'] != src_channels:
        rows.append({'field': 'channel layout note', 'reported': rec_probe['channels'], 'reference': src_channels, 'delta': None,
                     'note': 'BS.1770 sums channel powers: a duplicated mono source reads +3.01 LU as stereo'})
    return rows

# ----------------------------------------------------------------------------- comparison
def load_report(path):
    with open(path, encoding='utf-8') as handle:
        data = json.load(handle)
    if 'audioMetrics' in data:
        return data, data.get('evaluation') or data.get('_evaluation')
    return data.get('report') or {}, data.get('evaluation')


def get(obj, *keys):
    for key in keys:
        if obj is None:
            return None
        obj = obj.get(key) if isinstance(obj, dict) else None
    return obj


def verdict(delta, tol):
    if delta is None:
        return 'N/A'
    return 'PASS' if abs(delta) <= tol else 'FAIL'


def row(rows, field, reported, reference, tol=None, note=''):
    delta = None
    if isinstance(reported, (int, float)) and isinstance(reference, (int, float)) \
            and math.isfinite(reported) and math.isfinite(reference):
        delta = round(reported - reference, 3)
    status = 'OBS' if tol is None else verdict(delta, tol)
    rows.append({'field': field, 'reported': reported, 'reference': reference, 'delta': delta, 'tol': tol,
                 'verdict': status, 'note': note})


def compare_entry(entry, report, evaluation, ref, chain_rows=None):
    metrics = report.get('audioMetrics') or {}
    coverage = metrics.get('coverage') or {}
    recording = report.get('recording') or {}
    lossy = (ref['probe']['codec'] or '') not in ('pcm_s16le', 'pcm_s24le', 'pcm_f32le')
    basis = ref.get('resampled') or ref['native']
    rows = []
    row(rows, 'coverage.sampleRate', coverage.get('sampleRate'), ref['probe']['sampleRate'], None,
        'decoder resample' if coverage.get('sampleRate') != ref['probe']['sampleRate'] else 'same rate')
    row(rows, 'coverage.numberOfChannels', coverage.get('numberOfChannels'), ref['probe']['channels'], 0)
    row(rows, 'audioMetrics.durationMs', metrics.get('durationMs'), basis['durationMs'], TOL['durationMs'])
    row(rows, 'recording.durationMs', recording.get('durationMs'), round(ref['probe']['durationSec'] * 1000, 1), None,
        'capture timer vs container')
    row(rows, 'recording.blobSize', recording.get('blobSize'), ref['probe']['sizeBytes'], 0)
    if recording.get('actualBitrate') and ref['probe']['bitRate']:
        pct = (recording['actualBitrate'] - ref['probe']['bitRate']) / ref['probe']['bitRate'] * 100
        rows.append({'field': 'recording.actualBitrate (bps)', 'reported': recording['actualBitrate'],
                     'reference': ref['probe']['bitRate'], 'delta': round(pct, 1), 'tol': TOL['bitratePct'],
                     'verdict': verdict(pct, TOL['bitratePct']), 'note': 'delta in %'})
    rms_tol, peak_tol = (TOL['rms.lossy'], TOL['peak.lossy']) if lossy else (TOL['rms.wav'], TOL['peak.wav'])
    pct_tol, band_tol = (TOL['percentile.lossy'], TOL['band.lossy']) if lossy else (TOL['percentile'], TOL['band'])
    row(rows, 'lufs.integrated (ffmpeg ebur128 I)', get(metrics, 'lufs', 'integrated'), ref['ebur128']['integrated'],
        TOL['lufs.integrated'], 'ffmpeg rounds to 0.1')
    row(rows, 'lufs.integrated (numpy BS.1770)', get(metrics, 'lufs', 'integrated'), basis['lufs']['integrated'],
        TOL['lufs.integrated'])
    overall = ref['astats'].get('overall', {})
    row(rows, 'signal.rmsDb (ffmpeg astats overall)', get(metrics, 'signal', 'rmsDb'), overall.get('RMS level dB'), rms_tol)
    row(rows, 'signal.rmsDb (numpy)', get(metrics, 'signal', 'rmsDb'), basis['rmsDb'], rms_tol)
    row(rows, 'signal.peakDb (ffmpeg astats overall)', get(metrics, 'signal', 'peakDb'), overall.get('Peak level dB'), peak_tol)
    row(rows, 'signal.peakDb (numpy)', get(metrics, 'signal', 'peakDb'), basis['peakDb'], peak_tol)
    row(rows, 'signal.maxBlockRmsDb', get(metrics, 'signal', 'maxBlockRmsDb'), basis['maxBlockRmsDb'], TOL['maxBlockRms'])
    row(rows, 'signal.crestFactorDb', get(metrics, 'signal', 'crestFactorDb'), basis.get('crestFactorDb'), pct_tol)
    row(rows, 'truePeak.db (numpy BS.1770-4 FIR)', get(metrics, 'truePeak', 'db'), basis.get('truePeakDb'), peak_tol,
        'lossy files: different decoders' if lossy else '')
    row(rows, 'truePeak.db (ffmpeg ebur128 true peak)', get(metrics, 'truePeak', 'db'), ref['ebur128']['truePeakDb'], 0.3,
        'different interpolation filters')
    row(rows, 'ceiling.ceilingDb', get(metrics, 'ceiling', 'ceilingDb'), (basis.get('ceiling') or {}).get('ceilingDb'), 0.1)
    row(rows, 'ceiling.flatTopRate', get(metrics, 'ceiling', 'flatTopRate'), (basis.get('ceiling') or {}).get('flatTopRate'), 0.002)
    row(rows, 'ceiling.nearCeilingRate', get(metrics, 'ceiling', 'nearCeilingRate'), (basis.get('ceiling') or {}).get('nearCeilingRate'), 0.002)
    rows.append({'field': 'channelLayout', 'reported': metrics.get('channelLayout'), 'reference': basis.get('channelLayout'), 'delta': None,
                 'tol': None, 'verdict': 'PASS' if metrics.get('channelLayout') == basis.get('channelLayout') else 'FAIL',
                 'note': f"max channel difference {fmt(basis.get('channelMaxDifferenceDb'))} dB"})
    row(rows, 'lufs.integratedMonoEquivalent', get(metrics, 'lufs', 'integratedMonoEquivalent'), basis['lufs'].get('integratedMonoEquivalent'),
        TOL['lufs.integrated'])
    for index, channel in enumerate(metrics.get('channels') or []):
        if index < len(basis['channels']):
            row(rows, f'channels[{index}].rmsDb', channel.get('rmsDb'), basis['channels'][index]['rmsDb'], rms_tol)
            row(rows, f'channels[{index}].peakDb', channel.get('peakDb'), basis['channels'][index]['peakDb'], peak_tol)
            row(rows, f'channels[{index}].saturatedSamples', channel.get('saturatedSamples'),
                basis['channels'][index]['saturatedSamples'], None if lossy else 0)
    row(rows, 'clipping.saturatedSamples', get(metrics, 'clipping', 'saturatedSamples'),
        basis['clipping']['saturatedSamples'], None if lossy else 0)
    row(rows, 'clipping.eventCount', get(metrics, 'clipping', 'eventCount'), basis['clipping']['eventCount'],
        None if lossy else 0)
    row(rows, 'headroom.nearPeakRate', get(metrics, 'headroom', 'nearPeakRate'), basis['headroom']['nearPeakRate'],
        None if lossy else 1e-6)
    row(rows, 'silence.totalDurationMs', get(metrics, 'silence', 'totalDurationMs'), basis['silence']['totalDurationMs'],
        TOL['silenceMs'])
    row(rows, 'silence.count', get(metrics, 'silence', 'count'), basis['silence']['count'], None)
    row(rows, 'lowLevel.percentileDb', get(metrics, 'lowLevel', 'percentileDb'), basis['lowLevelPercentileDb'], pct_tol)
    row(rows, 'dynamicRange.db', get(metrics, 'dynamicRange', 'db'), basis['dynamicRangeDb'], pct_tol)
    row(rows, 'stability.dbStdDev', get(metrics, 'stability', 'dbStdDev'), basis['stabilityDbStdDev'], pct_tol)
    row(rows, 'weakSignal.frames', get(metrics, 'weakSignal', 'frames'), basis['weakSignal']['frames'], None)
    spectrum = basis.get('spectrum') or {}
    for band in BANDS:
        row(rows, f'frequencyProfile.{band}', get(metrics, 'frequencyProfile', band), (spectrum.get('bands') or {}).get(band),
            band_tol)
    row(rows, 'deepAnalysis.spectralFlatness', report.get('deepAnalysis', {}).get('spectralFlatness'),
        spectrum.get('spectralFlatness'), 0.02)
    row(rows, 'frequencyResponse.frameCount', get(metrics, 'frequencyResponse', 'frameCount'), spectrum.get('frameCount'), 0)
    # Fields that must stay unmeasured (no controlled noise / speech segments exist).
    for field in ('noiseFloor', 'snr', 'dropouts'):
        status = get(metrics, field, 'status')
        rows.append({'field': f'{field}.status', 'reported': status, 'reference': 'unavailable', 'delta': None, 'tol': None,
                     'verdict': 'PASS' if status == 'unavailable' else 'FAIL', 'note': 'must not produce a number'})
    crest = basis.get('crestFactorDb')
    # Findings from the app's own free evaluator versus the scenario expectation.
    findings = sorted({f.get('id') for f in (evaluation or {}).get('findings', []) if f.get('id')})
    expected = sorted(set(entry.get('expectFindings') or []))
    finding_rows = {'reported': findings, 'expected': expected, 'overall': (evaluation or {}).get('overall'),
                    'missed': sorted(set(expected) - set(findings)), 'unexpected': sorted(set(findings) - set(expected))}
    chain = chain_rows
    return {'rows': rows, 'findings': finding_rows, 'chain': chain, 'lossy': lossy,
            'device': {'micName': get(report, 'device', 'micName'), 'sampleRate': get(report, 'device', 'sampleRate'),
                       'channelCount': get(report, 'device', 'channelCount'),
                       'applied': get(report, 'profile', 'appliedConstraints'),
                       'requested': get(report, 'profile', 'requestedConstraints')},
            'loopback': {k: get(report, 'loopback', k) for k in ('senderCodec', 'receiverCodec', 'requestedKbps', 'actualKbps',
                                                                 'rttMs', 'jitterMs', 'packetLossRate', 'receive')}
            if report.get('loopback') else None,
            'recording': {k: recording.get(k) for k in ('mimeType', 'encoder', 'pipeline', 'requestedBitrate', 'actualBitrate',
                                                        'bitrateMode', 'sampleCount', 'stopReason')},
            'deepStatus': get(report, 'deepAnalysis', 'status'), 'deepReason': get(report, 'deepAnalysis', 'reason')}


def fmt(value):
    if value is None:
        return '—'
    if isinstance(value, float):
        return f'{value:.4g}' if abs(value) < 1e-3 and value != 0 else f'{value:.2f}'
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def render_markdown(results, manifest_meta):
    lines = [f"# Reference comparison — {manifest_meta.get('layer', 'ad-hoc')}", '',
             f"Generated {datetime.now(timezone.utc).isoformat(timespec='seconds')} with ffmpeg at `{FFMPEG}`.",
             'PASS/FAIL use the plan tolerances; OBS rows are observations without a pass criterion.', '']
    summary = ['| id | profile | scenario | deep | LUFS (rep) | LUFS Δ | RMS Δ | peak Δ | crest dB | silence Δms | clip (rep/ref) | findings | verdict |',
               '|---|---|---|---|---|---|---|---|---|---|---|---|---|']
    for res in results:
        rows = {r['field']: r for r in res['comparison']['rows']}
        def d(field):
            return fmt(rows.get(field, {}).get('delta'))
        clip = f"{fmt(rows.get('clipping.saturatedSamples', {}).get('reported'))}/{fmt(rows.get('clipping.saturatedSamples', {}).get('reference'))}"
        fails = [r['field'] for r in res['comparison']['rows'] if r['verdict'] == 'FAIL']
        fnd = res['comparison']['findings']
        findings_txt = ','.join(fnd['reported']) or 'none'
        if fnd['missed'] or fnd['unexpected']:
            findings_txt += f" (missed {fnd['missed'] or '-'}; unexpected {fnd['unexpected'] or '-'})"
        lufs_rep = fmt(rows.get('lufs.integrated (ffmpeg ebur128 I)', {}).get('reported'))
        crest = fmt(rows.get('signal.crestFactorDb', {}).get('reference'))
        summary.append(f"| {res['id']} | {res['profile']} | {res['scenario']} | {res['comparison']['deepStatus']} | {lufs_rep} | "
                       f"{d('lufs.integrated (ffmpeg ebur128 I)')} | {d('signal.rmsDb (numpy)')} | {d('signal.peakDb (numpy)')} | {crest} | "
                       f"{d('silence.totalDurationMs')} | {clip} | {findings_txt} | {'FAIL: ' + ', '.join(fails) if fails else 'PASS'} |")
    lines += summary + ['']
    for res in results:
        comp = res['comparison']
        lines += [f"## {res['id']} — {res['profile']} — {res['scenario']}", '',
                  f"Audio `{res['audio']}` ({res['reference']['probe']['codec']}, {res['reference']['probe']['sampleRate']} Hz, "
                  f"{res['reference']['probe']['channels']} ch, {res['reference']['probe']['durationSec']:.3f} s, "
                  f"{res['reference']['probe']['bitRate']} bps). Report `{res['report']}`.", '']
        if res.get('notes'):
            lines += [f"Notes: {res['notes']}", '']
        lines += [f"Device: {fmt(comp['device'])}", '', f"Recording: {fmt(comp['recording'])}", '']
        if comp['loopback']:
            lines += [f"Loopback: {fmt(comp['loopback'])}", '']
        lines += ['| field | reported | reference | Δ | tol | verdict | note |', '|---|---|---|---|---|---|---|']
        for r in comp['rows']:
            lines.append(f"| {r['field']} | {fmt(r['reported'])} | {fmt(r['reference'])} | {fmt(r['delta'])} | "
                         f"{fmt(r['tol'])} | {r['verdict']} | {r['note']} |")
        fnd = comp['findings']
        lines += ['', f"Findings: reported {fnd['reported'] or 'none'}; expected {fnd['expected'] or 'none'}; "
                      f"overall {fmt(fnd['overall'])}; missed {fnd['missed'] or '-'}; unexpected {fnd['unexpected'] or '-'}", '']
        if comp['chain']:
            lines += ['Chain loss versus the aligned source segment (report − source):', '',
                      '| field | report | source | Δ | note |', '|---|---|---|---|---|']
            for item in comp['chain']:
                lines.append(f"| {item['field']} | {fmt(item['reported'])} | {fmt(item['reference'])} | {fmt(item['delta'])} | {item.get('note', '')} |")
            lines.append('')
    return '\n'.join(lines)


def process_manifest(manifest_path, out_dir):
    base = os.path.dirname(os.path.abspath(manifest_path))
    with open(manifest_path, encoding='utf-8') as handle:
        manifest = json.load(handle)
    source_ref = source_path = None
    if manifest.get('sourceWav'):
        source_path = os.path.join(base, manifest['sourceWav'])
        source_ref = measure(source_path)
    results = []
    for entry in manifest.get('entries', []):
        audio = os.path.join(base, entry['audio'])
        report_path = os.path.join(base, entry['report'])
        report, evaluation = load_report(report_path)
        decode_rate = get(report, 'audioMetrics', 'coverage', 'sampleRate')
        ref = measure(audio, decode_rate)
        chain = chain_against_source(source_path, source_ref, audio, report) if source_ref else None
        comparison = compare_entry(entry, report, evaluation, ref, chain)
        results.append({'id': entry.get('id'), 'profile': entry.get('profile') or get(report, 'profile', 'id'),
                        'scenario': entry.get('scenario', ''), 'audio': entry['audio'], 'report': entry['report'],
                        'notes': entry.get('notes'), 'reference': ref, 'comparison': comparison})
        fails = [r['field'] for r in comparison['rows'] if r['verdict'] == 'FAIL']
        print(f"{entry.get('id')}: {'FAIL ' + ', '.join(fails) if fails else 'PASS'}; findings {comparison['findings']['reported']}")
    out_dir = out_dir or base
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, 'comparison.json'), 'w', encoding='utf-8') as handle:
        json.dump({'manifest': manifest, 'sourceReference': source_ref, 'results': results}, handle, ensure_ascii=False, indent=2,
                  default=lambda value: None if isinstance(value, float) and not math.isfinite(value) else str(value))
    markdown = render_markdown(results, manifest)
    with open(os.path.join(out_dir, 'comparison.md'), 'w', encoding='utf-8') as handle:
        handle.write(markdown)
    print(f"wrote {os.path.join(out_dir, 'comparison.md')}")
    return results


# ----------------------------------------------------------------------------- self-test
def write_wav(path, sample_rate, channels_data):
    data = np.stack(channels_data, axis=1) if len(channels_data) > 1 else channels_data[0][:, None]
    wavfile.write(path, sample_rate, np.clip(np.round(data * 32768), -32768, 32767).astype(np.int16))


def selftest(out_dir):
    """Known signals: EBU Tech 3341-style −23 dBFS 1 kHz sine (stereo → −23.0 LUFS, mono → −26.0)."""
    os.makedirs(out_dir, exist_ok=True)
    cases = []
    for rate in (48000, 44100):
        t = np.arange(int(10 * rate)) / rate
        sine = 10 ** (-23 / 20) * np.sin(2 * np.pi * 1000 * t)
        loud = 10 ** (-20 / 20) * np.sin(2 * np.pi * 1000 * t)
        cases += [(f'stereo-23dbfs-{rate}', rate, [sine, sine], -23.0), (f'mono-23dbfs-{rate}', rate, [sine], -26.0),
                  (f'stereo-right-silent-{rate}', rate, [loud, np.zeros_like(loud)], -23.0)]
    failures = 0
    print(f"{'case':30} {'ffmpeg I':>9} {'numpy I':>9} {'expect':>7} {'astats RMS':>11} {'numpy RMS':>10} {'astats pk':>10} {'numpy pk':>9}")
    for name, rate, chans, expect in cases:
        path = os.path.join(out_dir, f'selftest-{name}.wav')
        write_wav(path, rate, chans)
        ref = measure(path)
        ffm, npy = ref['ebur128']['integrated'], ref['native']['lufs']['integrated']
        rms_a, rms_n = ref['astats']['overall'].get('RMS level dB'), ref['native']['rmsDb']
        pk_a, pk_n = ref['astats']['overall'].get('Peak level dB'), ref['native']['peakDb']
        ok = abs(ffm - expect) <= 0.1 and abs(npy - expect) <= 0.1 and abs(rms_a - rms_n) <= 0.05 and abs(pk_a - pk_n) <= 0.05
        failures += 0 if ok else 1
        print(f"{name:30} {ffm:9.2f} {npy:9.2f} {expect:7.1f} {rms_a:11.2f} {rms_n:10.2f} {pk_a:10.2f} {pk_n:9.2f} {'ok' if ok else 'FAIL'}")
    print('selftest', 'PASS' if not failures else f'FAIL ({failures})')
    return failures == 0


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--manifest')
    parser.add_argument('--audio')
    parser.add_argument('--report')
    parser.add_argument('--label', default='ad-hoc')
    parser.add_argument('--expect', default='', help='comma separated expected finding ids')
    parser.add_argument('--source-wav', help='known source WAV for chain-loss rows')
    parser.add_argument('--out')
    parser.add_argument('--selftest', action='store_true')
    args = parser.parse_args()
    if not os.path.exists(FFMPEG):
        sys.exit(f'ffmpeg not found at {FFMPEG}; set MICPROBE_FFMPEG_DIR')
    if args.selftest:
        sys.exit(0 if selftest(args.out or os.path.join(os.path.dirname(__file__), '..', '.tmp', 'real-capture', 'selftest')) else 1)
    if args.manifest:
        process_manifest(args.manifest, args.out)
        return
    if args.audio and args.report:
        base = os.path.dirname(os.path.abspath(args.report))
        manifest = {'layer': 'ad-hoc', 'sourceWav': os.path.relpath(args.source_wav, base) if args.source_wav else None,
                    'entries': [{'id': args.label, 'audio': os.path.relpath(args.audio, base),
                                 'report': os.path.relpath(args.report, base),
                                 'expectFindings': [f for f in args.expect.split(',') if f]}]}
        temp = os.path.join(args.out or base, f'{args.label}.manifest.json')
        os.makedirs(os.path.dirname(temp), exist_ok=True)
        with open(temp, 'w', encoding='utf-8') as handle:
            json.dump(manifest, handle)
        process_manifest(temp, args.out)
        return
    parser.print_help()


if __name__ == '__main__':
    main()
