"""Conservative file alignment at 8 kHz; never transforms measurement PCM.

Rigid alignment needs real correlation in both halves. Adaptive speech uses an
unambiguous ordered envelope consensus plus independent local waveform anchors.
Scores are matching evidence, not audio quality or calibrated probabilities.
"""
import math

import numpy as np
from scipy import signal

RATE = 8000
MIN_SIMILARITY = .5
LOCAL_RADIUS_SECONDS = .1
MAX_LOCAL_SPREAD_SECONDS = .05
EDGE_GUARD_SECONDS = .1


def normalized_correlation(template, received):
    """Sliding zero-mean NCC. Constant windows cannot pass through global DC."""
    if not len(template):
        return np.array([])
    a = template - template.mean()
    if len(received) < len(a) or np.dot(a, a) <= 1e-12:
        return np.array([])
    n = len(a)
    sums = np.r_[0., np.cumsum(received)]
    powers = np.r_[0., np.cumsum(received * received)]
    energy = np.maximum(0., powers[n:] - powers[:-n] - (sums[n:] - sums[:-n]) ** 2 / n)
    denominator = np.sqrt(energy * np.dot(a, a))
    numerator = signal.correlate(received, a, mode='valid', method='fft')
    scores = np.divide(numerator, denominator, out=np.zeros_like(numerator), where=denominator > 1e-10)
    return np.clip(scores, -1., 1.)


def local_match(x, y, start, end, center, radius=LOCAL_RADIUS_SECONDS):
    a = x[round(start * RATE):round(end * RATE)]
    left = max(0, round((start + center - radius) * RATE))
    right = min(len(y), round((end + center + radius) * RATE))
    if not len(a) or left >= right:
        return None
    scores = normalized_correlation(a, y[left:right])
    if not len(scores):
        return None
    index = int(np.argmax(np.abs(scores)))
    return {'startSeconds': start, 'endSeconds': end,
            'offsetSeconds': (left + index) / RATE - start,
            'similarity': float(abs(scores[index]))}


def rigid(x, y):
    result = {'status': 'unavailable', 'method': 'rigid waveform with independent half validation'}
    if min(len(x), len(y)) < RATE or np.std(x) < 1e-8 or np.std(y) < 1e-8:
        return {**result, 'reason': 'insufficient-nonzero-audio'}
    a, b = x - x.mean(), y - y.mean()
    correlation = signal.correlate(b, a, method='fft')
    lags = signal.correlation_lags(len(b), len(a))
    overlap = np.minimum(len(a) - np.maximum(0, -lags), len(b) - np.maximum(0, lags))
    permitted = overlap >= .8 * len(a)
    if not permitted.any():
        return {**result, 'reason': 'insufficient-reference-overlap'}
    lag = int(lags[permitted][np.argmax(np.abs(correlation[permitted]))])
    ix, iy = max(0, -lag), max(0, lag)
    n = min(len(x) - ix, len(y) - iy)
    score = normalized_correlation(x[ix:ix + n], y[iy:iy + n])
    score = float(abs(score[0])) if len(score) else 0.
    result.update(offsetSeconds=lag / RATE, similarity=score, overlapSeconds=n / RATE)
    if score < MIN_SIMILARITY:
        return {**result, 'reason': 'weak-or-incomplete-alignment'}
    halves = [local_match(x, y, (ix + left) / RATE, (ix + right) / RATE, lag / RATE)
              for left, right in ((0, n // 2), (n // 2, n))]
    result['halves'] = halves
    if any(h is None or h['similarity'] < MIN_SIMILARITY for h in halves):
        return {**result, 'reason': 'weak-independent-half'}
    if abs(halves[0]['offsetSeconds'] - halves[1]['offsetSeconds']) > .025:
        return {**result, 'reason': 'alignment-drift-between-halves'}
    return {**result, 'status': 'aligned'}


def envelope(x):
    block = RATE // 100
    return np.sqrt(np.mean(x[:len(x) // block * block].reshape(-1, block) ** 2, axis=1))


def ordered_speech(x, y, sections):
    ex, ey = envelope(x), envelope(y)
    candidates = {}
    for section in sections:
        start, end = section['startSeconds'], section['endSeconds']
        scores = normalized_correlation(ex[round(start * 100):round(end * 100)], ey)
        peaks, _ = signal.find_peaks(np.r_[-1., scores, -1.], height=MIN_SIMILARITY, distance=20)
        candidates[section['name']] = [
            {'offsetSeconds': (int(i) - 1) / 100 - start, 'similarity': float(scores[i - 1])}
            for i in peaks]
    hypotheses = []
    required = len(sections)
    for row in candidates.values():
        for seed in row:
            support = {}
            for name, options in candidates.items():
                close = [c for c in options if abs(c['offsetSeconds'] - seed['offsetSeconds']) <= .1]
                if close:
                    support[name] = max(close, key=lambda c: c['similarity'])
            if len(support) >= required:
                hypotheses.append({'offsetSeconds': float(np.median([c['offsetSeconds'] for c in support.values()])),
                                   'support': support, 'score': min(c['similarity'] for c in support.values())})
    if not hypotheses:
        return {'status': 'unavailable', 'reason': 'insufficient-ordered-speech-evidence'}
    most = max(len(h['support']) for h in hypotheses)
    hypotheses = [h for h in hypotheses if len(h['support']) == most]
    best = max(hypotheses, key=lambda h: h['score'])
    # Do not let amplitude choose between equally complete repeated sequences.
    if any(abs(h['offsetSeconds'] - best['offsetSeconds']) > .2 for h in hypotheses):
        return {'status': 'unavailable', 'reason': 'ambiguous-repeated-sequence'}
    return {**best, 'status': 'aligned', 'method': 'ordered 10-ms envelope consensus'}


def speech_section(x, y, section, coarse):
    start, end = section['startSeconds'], section['endSeconds']
    result = {'status': 'unavailable', 'method': 'ordered envelope and local waveform',
              'coarseOffsetSeconds': coarse, 'edgeTrimSeconds': EDGE_GUARD_SECONDS}
    if start + coarse - LOCAL_RADIUS_SECONDS < 0 or end + coarse + LOCAL_RADIUS_SECONDS > len(y) / RATE:
        return {**result, 'reason': 'section-boundary-not-covered'}
    windows = [local_match(x, y, float(t), float(t + 1), coarse)
               for t in np.arange(start, end - 1 + 1e-6, 1.)]
    good = [w for w in windows if w is not None and w['similarity'] >= MIN_SIMILARITY]
    result.update(windows=windows, acceptedWindows=len(good), totalWindows=len(windows))
    middle = (start + end) / 2
    if (len(good) < max(3, math.ceil(len(windows) / 2)) or
            not any(w['endSeconds'] <= middle for w in good) or
            not any(w['startSeconds'] >= middle for w in good)):
        return {**result, 'reason': 'insufficient-distributed-waveform-anchors'}
    lo, hi = min(w['offsetSeconds'] for w in good), max(w['offsetSeconds'] for w in good)
    result.update(offsetRangeSeconds=[lo, hi])
    if hi - lo > MAX_LOCAL_SPREAD_SECONDS:
        return {**result, 'reason': 'local-timing-spread-too-large'}
    return {**result, 'status': 'aligned', 'offsetSeconds': float(np.median([w['offsetSeconds'] for w in good])),
            'similarity': float(np.median([w['similarity'] for w in good]))}


def estimate(x, y, sections=()):
    validate_sections(sections, len(x) / RATE)
    result = rigid(x, y)
    speech = [s for s in sections if s['kind'] in ('speech', 'speech-noise') and s['endSeconds'] - s['startSeconds'] >= 3]
    if len(speech) < 2:
        return result
    consensus = ordered_speech(x, y, speech)
    result['orderedSpeech'] = consensus
    if consensus['status'] != 'aligned':
        return {**result, 'status': 'unavailable', 'reason': consensus['reason']}
    if result['status'] == 'aligned' and abs(result['offsetSeconds'] - consensus['offsetSeconds']) <= .1:
        # A verified rigid mapping preserves existing whole-section measurements.
        return result
    mappings = {s['name']: speech_section(x, y, s, consensus['offsetSeconds']) for s in speech}
    for s in sections:
        mappings.setdefault(s['name'], {'status': 'unavailable', 'reason': 'no-independent-section-alignment'})
    return {'status': 'partial' if any(v['status'] == 'aligned' for v in mappings.values()) else 'unavailable',
            'method': 'ordered speech with local waveform validation', 'rigidAttempt': result,
            'sections': mappings, 'orderedSpeech': consensus,
            'limitation': 'Local file matching only. No PCM time stretching, latency claim or extrapolation to unverified sections.'}


def validate_sections(sections, duration):
    """Reject malformed/overlapping recipes before they can select measurement PCM."""
    if not isinstance(sections, (list, tuple)):
        raise ValueError('recipe-segments-must-be-a-list')
    names, previous_end = set(), 0.
    for section in sections:
        if not isinstance(section, dict):
            raise ValueError('invalid-recipe-segment')
        name, kind = section.get('name'), section.get('kind')
        start, end = section.get('startSeconds'), section.get('endSeconds')
        if not isinstance(name, str) or not name or name in names or not isinstance(kind, str) or not kind:
            raise ValueError('invalid-or-duplicate-segment-name-or-kind')
        if any(type(t) not in (int, float) or not math.isfinite(t) for t in (start, end)):
            raise ValueError('invalid-segment-time')
        if not previous_end <= start < end <= duration + 1e-9:
            raise ValueError('segment-outside-reference-or-unordered-overlap')
        names.add(name)
        previous_end = end
