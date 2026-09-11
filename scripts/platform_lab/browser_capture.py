"""Import a stopped, run-bound collector from an authorized application page."""
import base64
import json
import uuid

from . import bundle, rtp


def unpack(data, run_id, capture_point='receiver'):
    version = data.get('schemaVersion')
    if version not in (1, 2) or data.get('runId') != run_id:
        raise ValueError('Browser capture belongs to another run or schema')
    state = data.get('state', {})
    if state.get('runId') != run_id or state.get('collecting') is not False or state.get('captureActive') is not False:
        raise ValueError('Stop the browser collector before exporting')
    if state.get('errors'):
        raise ValueError('Browser collector reported errors; retain as evidence, not a valid capture')
    records = data.get('records', [])
    metadata = [r for r in records if r.get('kind') == 'metadata']
    if len(metadata) != 1 or metadata[0].get('runId') != run_id:
        raise ValueError('Expected one matching capture metadata record')
    if capture_point not in ('receiver', 'sender-outbound', 'browser-input') or metadata[0].get('capturePoint', 'receiver') != capture_point:
        raise ValueError('Capture point mismatch; sender audio must not be labeled as receiver audio')
    if version == 2:
        capture_id = data.get('captureId')
        if (not isinstance(capture_id, str) or not capture_id or state.get('captureId') != capture_id or
                state.get('pending') != 0 or any(r.get('captureId') != capture_id or r.get('runId') != run_id or
                                               r.get('sequence') != i for i, r in enumerate(records))):
            raise ValueError('Capture identity, ordered records or final write completion mismatch')
    if capture_point == 'browser-input':
        meta = metadata[0]
        provenance = meta.get('inputProvenance') or {}
        if (version != 2 or meta.get('statsScope') != 'none' or meta.get('connectionId') is not None or
                meta.get('trackSelection') != 'explicit-track-id' or not meta.get('trackId') or
                meta['trackId'] not in meta.get('availableTrackIds', []) or
                provenance.get('kind') != 'observed-getUserMedia-result' or provenance.get('observerRunId') != run_id or
                not provenance.get('observerStartedAt') or any(r.get('kind') == 'stats' for r in records)):
            raise ValueError('Browser input requires observed track provenance and must not claim RTP statistics')
    if metadata[0].get('captureMime') != 'audio/webm;codecs=pcm':
        raise ValueError('Expected lossless PCM container; do not treat lossy re-encoding as receiver PCM')
    if sum(r.get('kind') == 'event' and r.get('name') == 'pcm-start' for r in records) != 1:
        raise ValueError('Expected one continuous PCM recording')
    if not any(r.get('kind') == 'event' and r.get('name') == 'collector-stop' for r in records):
        raise ValueError('Missing persisted stop event; capture completion is unverified')
    chunks, samples = [], []
    for record in records:
        if record.get('kind') == 'pcm-container':
            chunk = base64.b64decode(record['dataBase64'], validate=True)
            if version == 2 and (not chunk or len(chunk) != record.get('byteLength')):
                raise ValueError('PCM chunk length mismatch')
            chunks.append(chunk)
        if record.get('kind') != 'stats':
            continue
        reports = {s['id']: s for s in record['reports']}
        for report in reports.values():
            if report.get('kind', report.get('mediaType')) != 'audio' or report.get('type') not in ('inbound-rtp', 'outbound-rtp'):
                continue
            inbound = report['type'] == 'inbound-rtp'
            sample = dict(connectionId=record['connectionId'], streamId=report['id'],
                          direction='inbound' if inbound else 'outbound', timestampMs=report['timestamp'],
                          bytes=report['bytesReceived' if inbound else 'bytesSent'],
                          packets=report['packetsReceived' if inbound else 'packetsSent'])
            if report.get('codecId') in reports:
                sample['codec'] = reports[report['codecId']]
            sample.update({dest: report[src] for src, dest in rtp.FIELDS.items() if src in report})
            samples.append(rtp.validate_sample(sample))
    if not chunks or (capture_point != 'browser-input' and not samples) or sum(map(len, chunks)) != state.get('pcmBytes'):
        raise ValueError('Missing or truncated PCM/statistics payload')
    if len(chunks) != state.get('pcmChunks') or sum(r.get('kind') == 'stats' for r in records) != state.get('statsCount'):
        raise ValueError('Capture counts do not match its payload')
    return b''.join(chunks), samples


def import_capture(run, source, capture_point='receiver'):
    root, manifest = bundle.load(run)
    data = rtp.read_json(source)
    pcm, samples = unpack(data, manifest['runId'], capture_point)
    folder = root / ('browser-import-' + uuid.uuid4().hex[:8])
    folder.mkdir()
    audio = folder / (capture_point + '.webm')
    audio.write_bytes(pcm)
    result = {'evidence': bundle.attach(root, source, 'evidence'),
              'audio': bundle.attach(root, audio, 'receiver-audio' if capture_point == 'receiver' else 'evidence')}
    if samples:
        stats = folder / (capture_point + '.jsonl')
        stats.write_text(''.join(json.dumps(s, allow_nan=False) + '\n' for s in samples), encoding='utf-8')
        result['stats'] = bundle.attach(root, stats, 'receiver-stats' if capture_point == 'receiver' else 'sender-stats', 'normalized-rtp')
    return result


def unpack_micprobe(data, run_id):
    """Validate both taps before writing; never turn a local profile into a platform default."""
    if (data.get('schemaVersion') != 1 or data.get('runId') != run_id or
            data.get('snapshot', {}).get('runId') != run_id or data.get('errors') != [] or
            data.get('liveInputTracks') != 0 or not data.get('stoppedAt') or
            data.get('stopReason') not in ('operator', 'reference-deadline') or
            data.get('settingsContext') != {'basis': 'local-profile', 'defaultEvidence': None, 'overrides': {}}):
        raise ValueError('Expected a completed, error-free local MicProbe baseline with released input')
    return {point: unpack(data.get('captures', {}).get(point, {}), run_id, point)
            for point in ('sender-outbound', 'receiver')}


def import_micprobe(run, source):
    root, manifest = bundle.load(run)
    if manifest['platform'] != 'micprobe':
        raise ValueError('MicProbe exports require a separate MicProbe run')
    data = rtp.read_json(source)
    captures = unpack_micprobe(data, manifest['runId'])
    folder = root / ('micprobe-import-' + uuid.uuid4().hex[:8])
    folder.mkdir()
    result = {'export': bundle.attach(root, source, 'evidence'), 'captures': {}}
    for point, (pcm, samples) in captures.items():
        audio, stats = folder / (point + '.webm'), folder / (point + '.jsonl')
        audio.write_bytes(pcm)
        stats.write_text(''.join(json.dumps(s, allow_nan=False) + '\n' for s in samples), encoding='utf-8')
        result['captures'][point] = {
            'audio': bundle.attach(root, audio, 'receiver-audio' if point == 'receiver' else 'evidence'),
            'stats': bundle.attach(root, stats, 'receiver-stats' if point == 'receiver' else 'sender-stats', 'normalized-rtp')}
    with bundle.edit_run(root) as (_, current):
        current['settingsContext'] = data['settingsContext']
    return result
