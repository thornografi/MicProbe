"""Run identity, immutable evidence copies and atomic manifests; no browser access."""
import hashlib
import json
import math
import os
import shutil
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

PLATFORMS = ('teams', 'webex', 'zoom', 'meet', 'discord', 'whatsapp', 'telegram', 'micprobe', 'other')
SURFACES = ('desktop-app', 'desktop-web', 'mobile-app', 'mobile-web')
ROLES = ('reference-audio', 'source-audio', 'receiver-audio', 'recipe',
         'sender-stats', 'receiver-stats', 'technology', 'native-log', 'routing-proof', 'evidence', 'source-levels')


def utc():
    return datetime.now(timezone.utc).isoformat()


def seconds(value):
    date = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if date.tzinfo is None:
        raise ValueError('A timestamp must include a timezone')
    return date.timestamp()


def clean(value):
    if isinstance(value, dict):
        return {str(k): clean(v) for k, v in value.items()}
    if isinstance(value, (tuple, list)):
        return [clean(v) for v in value]
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def save(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        with temp.open('x', encoding='utf-8') as handle:
            json.dump(clean(data), handle, ensure_ascii=False, indent=2, allow_nan=False)
            handle.flush()
            os.fsync(handle.fileno())
        temp.replace(path)
    finally:
        temp.unlink(missing_ok=True)


def digest(path):
    with Path(path).open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def load(run):
    root = Path(run).resolve()
    data = json.loads((root / 'run.json').read_text(encoding='utf-8'))
    if data.get('schemaVersion') != 1 or not data.get('runId'):
        raise ValueError('Unsupported or missing run schema')
    return root, data


@contextmanager
def edit_run(run):
    """Serialize capture/ingest/marker writers; atomic replacement alone loses updates."""
    root = Path(run).resolve()
    with (root / '.run.lock').open('a+b') as lock:
        if lock.tell() == 0:
            lock.write(b'0')
            lock.flush()
        lock.seek(0)
        if os.name == 'nt':
            import msvcrt
            msvcrt.locking(lock.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            _, data = load(root)
            yield root, data
            save(root / 'run.json', data)
        finally:
            lock.seek(0)
            if os.name == 'nt':
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def evidence_path(root, artifact):
    path = (root / artifact['path']).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError('Evidence path escapes the run directory')
    if not path.is_file() or digest(path) != artifact['sha256']:
        raise ValueError('Evidence missing or hash mismatch: ' + artifact['id'])
    return path


def init(run, platform, surface, mode):
    root = Path(run).resolve()
    root.mkdir(parents=True, exist_ok=False)
    (root / 'raw').mkdir()
    endpoint = dict(surface=surface, os=None, version=None, browser=None, device=None)
    data = dict(schemaVersion=1, runId=str(uuid.uuid4()), createdAt=utc(),
                platform=platform, mode=mode,
                endpoints={'sender': endpoint, 'receiver': {**endpoint, 'surface': None}},
                routing={'description': None, 'verified': False},
                settingsContext={'basis': 'observed-settings', 'defaultEvidence': None, 'overrides': {}},
                window={'startUtc': None, 'endUtc': None, 'maxStatsGapSeconds': 2.5},
                artifacts=[], events=[])
    save(root / 'run.json', data)
    return data


def attach(run, source, role, fmt=None):
    with edit_run(run) as (root, data):
        return _attach(root, data, source, role, fmt)


def _attach(root, data, source, role, fmt):
    source = Path(source).resolve()
    if role not in ROLES or not source.is_file():
        raise ValueError('Unknown role or missing source file')
    sha = digest(source)
    for existing in data['artifacts']:
        if existing['role'] == role and existing['sha256'] == sha:
            evidence_path(root, existing)
            return existing
    artifact_id = uuid.uuid4().hex[:12]
    destination = root / 'raw' / (artifact_id + ''.join(source.suffixes))
    with source.open('rb') as src, destination.open('xb') as dst:
        shutil.copyfileobj(src, dst)
        dst.flush()
        os.fsync(dst.fileno())
    if digest(destination) != sha:
        raise ValueError('Source changed while copying; evidence was not attached')
    artifact = dict(id=artifact_id, role=role, path=destination.relative_to(root).as_posix(),
                    sha256=sha, bytes=destination.stat().st_size, importedAt=utc(), format=fmt)
    data['artifacts'].append(artifact)
    return artifact


def mark(run, event, at=None):
    with edit_run(run) as (root, data):
        _mark(data, event, at)


def _mark(data, event, at=None):
    at = at or utc()
    seconds(at)
    if event in ('measure-start', 'measure-end'):
        key = 'startUtc' if event == 'measure-start' else 'endUtc'
        if data['window'][key]:
            raise ValueError('Measurement marker already exists; start another run')
        if key == 'endUtc' and (not data['window']['startUtc'] or
                               seconds(at) <= seconds(data['window']['startUtc'])):
            raise ValueError('Measurement end must follow its start')
        data['window'][key] = at
    data['events'].append({'event': event, 'at': at})


def technology(root, artifacts):
    accepted, rejected = [], []
    known = {artifact['id']: artifact for artifact in artifacts}
    for artifact in artifacts:
        if artifact['role'] != 'technology':
            continue
        content = json.loads(evidence_path(root, artifact).read_text(encoding='utf-8'))
        for item in content.get('observations', []):
            source = item.get('source', {})
            reason = None
            try:
                date = datetime.fromisoformat(source.get('date', '')).date()
                if date.year != 2026 or date > datetime.now(timezone.utc).date():
                    reason = 'Evidence must have a non-future 2026 date'
            except ValueError:
                reason = 'Missing evidence date; access date alone is insufficient'
            if source.get('kind') not in ('runtime', 'official-document'):
                reason = 'Runtime evidence or primary official documentation required'
            if source.get('kind') == 'official-document' and not source.get('url'):
                reason = 'Official documentation requires a URL'
            if source.get('kind') == 'runtime':
                linked = known.get(source.get('artifactId'))
                if not linked or linked['role'] not in ('native-log', 'evidence', 'routing-proof'):
                    reason = 'Runtime observation requires a linked log or screenshot evidence artifact'
                else:
                    evidence_path(root, linked)
            if item.get('scope') not in ('sender', 'receiver', 'route'):
                reason = 'Observation scope must identify sender, receiver or route'
            if not all(item.get(k) for k in ('field', 'scope', 'locator')) or 'value' not in item:
                reason = 'Field, scope, value and precise evidence locator required'
            record = {**item, 'artifactId': artifact['id'],
                      'status': 'documented' if source.get('kind') == 'official-document' else 'observed'}
            if reason:
                rejected.append({**record, 'status': 'rejected', 'reason': reason})
            else:
                accepted.append(record)
    return {'observations': accepted, 'rejected': rejected,
            'note': 'Evidence is supplied by the investigator; this tool does not verify a webpage or reverse engineer a client.'}
