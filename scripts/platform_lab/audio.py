"""Reuse MicProbe's reference measurements; align known stimuli, never normalize received audio."""
import importlib.util
import json
import math
import shutil
from functools import lru_cache
from pathlib import Path

import numpy as np
from scipy import signal
from scipy.io import wavfile

from .bundle import digest, evidence_path, save
from .alignment import estimate, validate_sections

ANALYSIS_REVISION = 'alignment-2'


@lru_cache(maxsize=1)
def reference_engine():
    path = Path(__file__).resolve().parents[1] / 'reference-audio-metrics.py'
    spec = importlib.util.spec_from_file_location('micprobe_reference', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    for name in ('FFMPEG', 'FFPROBE'):
        configured = getattr(module, name)
        setattr(module, name, shutil.which(name.lower()) or configured)
        if not Path(getattr(module, name)).is_file():
            raise ValueError(name + ' missing; set MICPROBE_FFMPEG_DIR or PATH')
    return module


def read_audio(path):
    engine = reference_engine()
    info = engine.ffprobe(str(path))
    duration, rate, channels = info['durationSec'], info['sampleRate'], info['channels']
    if not math.isfinite(duration) or not 0 < duration <= 180:
        raise ValueError('Audio needs a known duration of at most 180 seconds; no silent truncation')
    if channels not in (1, 2) or not 8000 <= rate <= 96000 or duration * rate * channels > 12_000_000:
        raise ValueError('Analysis supports mono/stereo, 8–96 kHz, at most 12 million decoded samples')
    pcm = engine.decode(str(path), channels)
    if not pcm.size or not np.isfinite(pcm).all():
        raise ValueError('Empty or non-finite decoded PCM')
    return pcm, rate, info


def level(pcm):
    power = float(np.mean(np.square(pcm.astype(np.float64))))
    return 10 * math.log10(power) if power > 1e-18 else None


def dominant(pcm):
    return pcm[:, int(np.argmax(np.mean(np.square(pcm.astype(np.float64)), axis=0)))]


def downsample(pcm, rate):
    divisor = math.gcd(rate, 8000)
    return signal.resample_poly(dominant(pcm), 8000 // divisor, rate // divisor).astype(np.float64)


def estimate_alignment(source, source_rate, received, received_rate, *, sections=()):
    """Match analysis copies only; measurement PCM retains its original samples."""
    return estimate(downsample(source, source_rate), downsample(received, received_rate), sections)


def make_reference(speech_path, output):
    speech, rate, _ = read_audio(speech_path)
    mono = dominant(speech)
    divisor = math.gcd(rate, 48000)
    mono = signal.resample_poly(mono, 48000 // divisor, rate // divisor)[:8 * 48000]
    if mono.size < 3 * 48000 or level(mono) is None:
        raise ValueError('Provide at least three seconds of non-silent reference speech')
    mono = np.tile(mono, math.ceil(8 * 48000 / mono.size))[:8 * 48000]
    gain = min(10 ** ((-24 - level(mono)) / 20), 0.65 / max(float(np.max(np.abs(mono))), 1e-9))
    mono = mono * gain
    rng = np.random.default_rng(20260909)

    def noise(duration, db=-36):
        value = rng.normal(size=round(duration * 48000))
        return value * 10 ** ((db - level(value)) / 20)

    segments, parts, cursor = [], [], 0

    def add(name, kind, value):
        nonlocal cursor
        if value.ndim == 1:
            value = np.column_stack((value, value))
        segments.append(dict(name=name, kind=kind, startSeconds=cursor / 48000,
                             endSeconds=(cursor + len(value)) / 48000))
        parts.append(value)
        cursor += len(value)

    add('sync-start', 'sync', noise(1, -24))
    add('silence', 'silence', np.zeros(3 * 48000))
    add('speech', 'speech', mono)
    add('quiet-speech', 'speech', mono * 10 ** (-18 / 20))
    add('speech-with-noise', 'speech-noise', mono + noise(8))
    add('noise-only', 'noise', noise(4))
    add('broadband', 'broadband', noise(4, -30))
    tone = 10 ** (-24 / 20) * np.sin(2 * np.pi * 1000 * np.arange(3 * 48000) / 48000)
    add('tone-1k', 'tone', tone)
    left, right = noise(2, -30), noise(2, -30)
    add('left-only', 'channel', np.column_stack((left, np.zeros_like(left))))
    add('right-only', 'channel', np.column_stack((np.zeros_like(right), right)))
    add('sync-end', 'sync', noise(1, -24))
    pcm = np.concatenate(parts)
    if float(np.max(np.abs(pcm))) >= 1:
        raise ValueError('Reference would clip')
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    wav = output / 'reference.wav'
    wavfile.write(wav, 48000, np.round(pcm * 32767).astype(np.int16))
    save(output / 'recipe.json', dict(schemaVersion=1, sampleRate=48000, channels=2,
                                     sourceSpeechSha256=digest(speech_path), referenceSha256=digest(wav),
                                     sourceSpeechGainDb=20 * math.log10(gain), segments=segments,
                                     note='Deterministic stimulus. Supply speech you may reuse. No playback or microphone access occurs.'))
    return output


def band_gains(source, received, sample_rate):
    # Relative recorded spectrum under this stimulus, not a calibrated bandwidth cutoff.
    f, x = signal.welch(source, fs=sample_rate, nperseg=min(4096, len(source)), axis=0)
    _, y = signal.welch(received, fs=sample_rate, nperseg=min(4096, len(received)), axis=0)
    result = []
    for lo, hi in zip((100, 250, 500, 1000, 2000, 4000, 6000, 8000, 12000),
                      (250, 500, 1000, 2000, 4000, 6000, 8000, 12000, 16000)):
        mask = (f >= lo) & (f < hi)
        baseline = float(x[mask].mean()) if mask.any() else 0
        output = float(y[mask].mean()) if mask.any() else 0
        value = 10 * math.log10(output / baseline) if baseline > 1e-14 and output > 1e-18 else None
        result.append({'fromHz': lo, 'toHz': hi, 'gainDb': value})
    return result


def section_comparisons(decoded, mappings, sections, source_present):
    """Measure unchanged PCM using only verified maps; never substitute a failed source."""
    rows = []
    basis = 'source-audio' if source_present else 'reference-audio'
    for section in sections:
        row = {'name': section['name'], 'kind': section['kind'], 'levelsDbfs': {},
               'ranges': {}, 'unavailable': {}, 'comparisonBasis': basis + ' → receiver-audio'}
        selected = {'reference-audio': {'status': 'aligned', 'offsetSeconds': 0}}
        for role in ('source-audio', 'receiver-audio'):
            mapping = mappings.get(role, {})
            selected[role] = mapping.get('sections', {}).get(section['name'], mapping)
        trim = max((m.get('edgeTrimSeconds', 0) for m in selected.values() if m.get('status') == 'aligned'), default=0)
        start, end = section['startSeconds'] + trim, section['endSeconds'] - trim
        row.update(referenceRangeSeconds=[start, end], edgeTrimSeconds=trim)
        parts = {}
        for role in ('reference-audio', basis, 'receiver-audio'):
            if role in parts or role in row['unavailable']:
                continue
            mapping = selected[role]
            if role not in decoded or mapping.get('status') != 'aligned':
                row['unavailable'][role] = mapping.get('reason', 'audio-or-alignment-unavailable')
                continue
            pcm, rate = decoded[role]
            a, b = round((start + mapping['offsetSeconds']) * rate), round((end + mapping['offsetSeconds']) * rate)
            if not 0 <= a < b <= len(pcm):
                row['unavailable'][role] = 'section-outside-recording'
                continue
            parts[role] = (pcm[a:b], rate)
            row['levelsDbfs'][role] = level(pcm[a:b])
            row['ranges'][role] = {'startSample': a, 'endSampleExclusive': b, 'sampleRate': rate,
                                   'startSeconds': a / rate, 'endSeconds': b / rate,
                                   'alignmentMethod': mapping.get('method', 'reference recipe')}
        row['status'] = 'measured' if basis in parts and 'receiver-audio' in parts else 'incomplete'
        before, after = row['levelsDbfs'].get(basis), row['levelsDbfs'].get('receiver-audio')
        row['gainDb'] = after - before if before is not None and after is not None else None
        if row['gainDb'] is None:
            row['gainUnavailableReason'] = 'missing-verified-pair' if row['status'] != 'measured' else 'zero-or-negligible-energy'
        if section['kind'] == 'broadband' and row['status'] == 'measured':
            x, xr = parts[basis]
            y, yr = parts['receiver-audio']
            common = min(xr, yr, 48000)
            def resample(pcm, rate):
                factor = math.gcd(common, rate)
                return signal.resample_poly(dominant(pcm), common // factor, rate // factor)
            row['recordedBandGains'] = band_gains(resample(x, xr), resample(y, yr), common)
        rows.append(row)
    return rows


def analyze(root, artifacts):
    files, decoded, errors = {}, {}, []
    for role in ('reference-audio', 'source-audio', 'receiver-audio'):
        candidates = [a for a in artifacts if a['role'] == role]
        if len(candidates) > 1:
            errors.append({'role': role, 'reason': 'multiple-files-for-role; use a separate run per condition'})
            continue
        if not candidates:
            continue
        artifact = candidates[0]
        try:
            path = evidence_path(root, artifact)
            pcm, rate, info = read_audio(path)
            engine = reference_engine()
            metrics = engine.pcm_metrics(pcm, rate)
            metrics['spectrum'] = engine.spectrum_metrics(pcm, rate)
            files[role] = dict(artifactId=artifact['id'], status='measured',
                               format=info, decodedSampleRate=rate, durationSeconds=len(pcm) / rate,
                               metrics=metrics, scope='Recorded file including its routing/recording effects; no microphone hardware verdict.')
            decoded[role] = (pcm, rate)
        except (ValueError, OSError, RuntimeError, KeyError) as error:
            errors.append({'role': role, 'reason': str(error)})
    mappings, comparisons = {}, []
    if 'reference-audio' in decoded:
        ref, ref_rate = decoded['reference-audio']
        sections = []
        recipes = [a for a in artifacts if a['role'] == 'recipe']
        if len(recipes) == 1:
            try:
                recipe = json.loads(evidence_path(root, recipes[0]).read_text(encoding='utf-8'))
                if not isinstance(recipe, dict):
                    raise ValueError('invalid-recipe')
                ref_artifact = next(a for a in artifacts if a['role'] == 'reference-audio')
                if recipe.get('referenceSha256') != ref_artifact['sha256']:
                    raise ValueError('reference-hash-mismatch')
                candidate_sections = recipe.get('segments', [])
                validate_sections(candidate_sections, len(ref) / ref_rate)
                sections = candidate_sections
            except (ValueError, OSError) as error:
                errors.append({'role': 'recipe', 'reason': str(error)})
        elif len(recipes) > 1:
            errors.append({'role': 'recipe', 'reason': 'multiple-recipes'})
        for role in ('source-audio', 'receiver-audio'):
            if role in decoded:
                mappings[role] = estimate_alignment(ref, ref_rate, *decoded[role], sections=sections)
        comparisons = section_comparisons(decoded, mappings, sections, any(a['role'] == 'source-audio' for a in artifacts))
    return {'analysisRevision': ANALYSIS_REVISION, 'files': files, 'alignment': mappings, 'segments': comparisons, 'errors': errors,
            'status': 'measured' if files and not errors else 'incomplete',
            'unknowns': {'aecEffect': 'Needs far-end reference, acoustic echo path and double-talk condition.',
                         'dspAlgorithm': 'Segment gain does not identify an internal algorithm.',
                         'acousticBandwidthHz': 'Band gains are stimulus-dependent; no automatic cutoff claim.',
                         'dropout': 'Silence alone is not a transport interruption.',
                         'thd': 'A tone is included, but a calibrated distortion analysis is not implemented.'}}
