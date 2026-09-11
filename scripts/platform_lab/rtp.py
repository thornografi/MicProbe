"""Chrome exports and explicit normalized samples; never scrape diagnostic pages."""
import gzip
import json
import math
from collections import defaultdict
from datetime import datetime, timezone
from statistics import median

from .bundle import evidence_path, seconds

FIELDS = {'jitter': 'jitterSeconds', 'packetsLost': 'lost', 'packetsDiscarded': 'discarded',
          'concealedSamples': 'concealedSamples', 'totalAudioEnergy': 'energy',
          'targetBitrate': 'targetBitrate', 'jitterBufferDelay': 'jitterBufferDelay',
          'jitterBufferEmittedCount': 'jitterBufferEmittedCount'}


def read_json(path):
    with path.open('rb') as handle:
        compressed = handle.read(2) == b'\x1f\x8b'
    with (gzip.open(path, 'rb') if compressed else path.open('rb')) as handle:
        payload = handle.read(128 * 1024 * 1024 + 1)
    if len(payload) > 128 * 1024 * 1024:
        raise ValueError('Statistics export exceeds 128 MiB decoded limit')
    return json.loads(payload)


def numeric(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def validate_sample(row):
    if not all(isinstance(row.get(k), str) and row[k] for k in ('connectionId', 'streamId')):
        raise ValueError('Sample needs connectionId and streamId')
    if row.get('direction') not in ('inbound', 'outbound'):
        raise ValueError('Sample direction must be inbound or outbound')
    if not all(numeric(row.get(k)) for k in ('timestampMs', 'bytes', 'packets')):
        raise ValueError('Sample requires finite timestampMs, bytes, packets')
    if row['timestampMs'] <= 0 or row['bytes'] < 0 or row['packets'] < 0:
        raise ValueError('Invalid sample clock or counter')
    try:
        date = datetime.fromtimestamp(row['timestampMs'] / 1000, timezone.utc).date()
    except (ValueError, OverflowError, OSError) as error:
        raise ValueError('Invalid UTC timestamp') from error
    if date.year != 2026 or date > datetime.now(timezone.utc).date():
        raise ValueError('This study accepts non-future 2026 observations only')
    for key in FIELDS.values():
        if key in row and not numeric(row[key]):
            raise ValueError('Non-numeric optional RTP field: ' + key)
    # Keep a narrow schema: never pass ICE addresses, credentials or SDP through.
    row = dict(row)
    if 'codec' in row:
        if not isinstance(row['codec'], dict):
            raise ValueError('codec must be an object')
        row['codec'] = {k: v for k, v in row['codec'].items() if k in ('mimeType', 'clockRate', 'channels', 'sdpFmtpLine')}
        if 'mimeType' in row['codec'] and (not isinstance(row['codec']['mimeType'], str) or not row['codec']['mimeType'].lower().startswith('audio/')):
            raise ValueError('Only audio codec records are supported')
    return {k: v for k, v in row.items() if k in
            {'connectionId', 'streamId', 'direction', 'timestampMs', 'bytes', 'packets', 'codec', *FIELDS.values()}}


def chrome_samples(data):
    if not isinstance(data.get('PeerConnections'), dict):
        raise ValueError('Expected a Chrome webrtc-internals export, not rtcstats or an audio recording')
    for pc_id, pc in data['PeerConnections'].items():
        stats = pc.get('stats', {})

        def values(prefix, field):
            item = stats.get(prefix + '-' + field)
            return json.loads(item['values']) if item else []

        for key, item in stats.items():
            kind = item.get('statsType')
            if not key.endswith('-kind') or kind not in ('inbound-rtp', 'outbound-rtp'):
                continue
            prefix = key[:-5]
            if set(values(prefix, 'kind')) != {'audio'}:
                continue
            direction = 'inbound' if kind == 'inbound-rtp' else 'outbound'
            byte_key, packet_key = ('bytesReceived', 'packetsReceived') if direction == 'inbound' else ('bytesSent', 'packetsSent')
            timestamps = values(prefix, 'timestamp')
            byte_values, packets = values(prefix, byte_key), values(prefix, packet_key)
            if not timestamps or len(timestamps) != len(byte_values) or len(packets) != len(timestamps):
                raise ValueError('Unaligned RTP timestamp/counter series')
            optional = {dest: values(prefix, src) for src, dest in FIELDS.items()}
            codec_ids = values(prefix, 'codecId')
            for i, stamp in enumerate(timestamps):
                row = dict(connectionId=pc_id, streamId=prefix, direction=direction,
                           timestampMs=stamp, bytes=byte_values[i], packets=packets[i])
                for field, series in optional.items():
                    if len(series) == len(timestamps):
                        row[field] = series[i]
                if len(codec_ids) == len(timestamps):
                    codec = {}
                    for field in ('mimeType', 'clockRate', 'channels', 'sdpFmtpLine'):
                        series = values(codec_ids[i], field)
                        # Constant codec fields can be safely used even if collection started later.
                        if series and all(value == series[0] for value in series):
                            codec[field] = series[0]
                    if codec:
                        row['codec'] = codec
                yield validate_sample(row)


def distribution(values):
    return {'min': min(values), 'median': median(values), 'max': max(values)} if values else None


def summarize(rows, window):
    by_time, conflicts = {}, []
    for row in rows:
        stamp = row['timestampMs']
        existing = by_time.get(stamp)
        if existing and any(existing[k] != row[k] for k in existing.keys() & row.keys()):
            conflicts.append(stamp)
        by_time[stamp] = {**(existing or {}), **row}
    ordered = sorted(by_time.values(), key=lambda r: r['timestampMs'])
    start, end = window.get('startUtc'), window.get('endUtc')
    requested = (seconds(start) * 1000, seconds(end) * 1000) if start and end else None
    if requested and requested[1] <= requested[0]:
        raise ValueError('Measurement end must follow start')
    max_gap = window.get('maxStatsGapSeconds', 2.5)
    if not numeric(max_gap) or max_gap <= 0:
        raise ValueError('maxStatsGapSeconds must be positive')
    reasons, intervals = [], []
    if not requested:
        reasons.append('measurement-window-missing')
    elif ordered[0]['timestampMs'] > requested[0] or ordered[-1]['timestampMs'] < requested[1]:
        reasons.append('measurement-window-not-covered')
    if conflicts:
        reasons.append('conflicting-overlapping-exports')
    for left, right in zip(ordered, ordered[1:]):
        a, b = left['timestampMs'], right['timestampMs']
        if requested and (b <= requested[0] or a >= requested[1]):
            continue
        duration = (b - a) / 1000
        if duration > max_gap:
            reasons.append('gap-in-statistics')
            continue
        if right['bytes'] < left['bytes'] or right['packets'] < left['packets']:
            reasons.append('rtp-counter-reset')
            continue
        # No invented within-sample interpolation: include only complete intervals.
        if requested and (a < requested[0] or b > requested[1]):
            continue
        interval = dict(startMs=a, endMs=b, seconds=duration,
                        bytes=right['bytes'] - left['bytes'], packets=right['packets'] - left['packets'])
        interval['payloadKbps'] = 8 * interval['bytes'] / duration / 1000
        for field in ('lost', 'discarded', 'concealedSamples', 'energy'):
            if field in left and field in right:
                interval[field + 'Delta'] = right[field] - left[field]
        if 'jitterSeconds' in right:
            interval['jitterMs'] = right['jitterSeconds'] * 1000
        intervals.append(interval)
    if not intervals:
        reasons.append('no-complete-sampling-intervals')
    valid = not reasons
    total_time = sum(row['seconds'] for row in intervals)
    delivered = sum(row['packets'] for row in intervals)
    lost = [row.get('lostDelta') for row in intervals]
    loss_rate = None
    if valid and lost and all(value is not None and value >= 0 for value in lost) and delivered + sum(lost) > 0:
        loss_rate = 100 * sum(lost) / (delivered + sum(lost))
    codecs = list({json.dumps(row.get('codec'), sort_keys=True): row['codec']
                   for row in ordered if row.get('codec')}.values())
    return dict(connectionId=ordered[0]['connectionId'], streamId=ordered[0]['streamId'],
                direction=ordered[0]['direction'], sampleCount=len(ordered),
                firstTimestampMs=ordered[0]['timestampMs'], lastTimestampMs=ordered[-1]['timestampMs'],
                coverage={'status': 'covered' if valid else 'insufficient', 'reasons': sorted(set(reasons)),
                          'sampledSeconds': total_time, 'boundaryPolicy': 'complete intervals only; no interpolation'},
                codecs=codecs, streamHasReceivedOrSentPackets=any(row['packets'] > 0 for row in ordered),
                lastCounters={key: ordered[-1][key] for key in ('bytes', 'packets', 'lost', 'energy', 'concealedSamples') if key in ordered[-1]},
                payloadKbps=(sum(row['bytes'] for row in intervals) * 8 / total_time / 1000) if valid else None,
                intervalPayloadKbps=distribution([row['payloadKbps'] for row in intervals]) if valid else None,
                packetLossPercent=loss_rate,
                jitterMs=distribution([row['jitterMs'] for row in intervals if 'jitterMs' in row]) if valid else None,
                targetBitrate=distribution([row['targetBitrate'] for row in ordered if 'targetBitrate' in row]),
                intervals=intervals,
                scope='This endpoint and direction only. RTP payload, not total network usage or native remote codec.')


def analyze(root, artifacts, window):
    groups, errors = defaultdict(list), []
    for artifact in artifacts:
        if artifact['role'] not in ('sender-stats', 'receiver-stats'):
            continue
        try:
            path = evidence_path(root, artifact)
            if artifact.get('format') == 'normalized-rtp':
                with path.open(encoding='utf-8') as handle:
                    rows = [validate_sample(json.loads(line)) for line in handle if line.strip()]
            else:
                rows = list(chrome_samples(read_json(path)))
            for row in rows:
                key = (artifact['role'], row['connectionId'], row['streamId'], row['direction'])
                groups[key].append(row)
        except (ValueError, KeyError, TypeError, OSError) as error:
            errors.append({'artifactId': artifact['id'], 'reason': str(error)})
    streams = [{**summarize(rows, window), 'endpoint': key[0].split('-')[0]} for key, rows in groups.items()]
    return {'streams': streams, 'errors': errors,
            'status': 'measured' if streams and not errors and all(s['coverage']['status'] == 'covered' for s in streams) else 'incomplete'}
