"""Run-bound read-only Windows volume notifications; no audio is opened or changed."""
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import uuid

from .bundle import _attach, edit_run, evidence_path, load, save, seconds

ROLE = 'source-levels'
FORMAT = 'windows-endpoint-levels'
HELPER = Path(__file__).parent / 'windows' / 'endpoint-levels.ps1'


def command(config):
    pwsh = shutil.which('pwsh')
    if os.name != 'nt' or not pwsh:
        raise ValueError('Endpoint monitoring requires Windows and PowerShell 7')
    return [pwsh, '-NoProfile', '-NonInteractive', '-File', str(HELPER), '-ConfigPath', str(config)]


def list_endpoints():
    with tempfile.TemporaryDirectory(prefix='micprobe-levels-', dir=r'C:\Tools\temp' if os.name == 'nt' else None) as folder:
        config = Path(folder) / 'config.json'
        save(config, {'action': 'list'})
        result = subprocess.run(command(config), capture_output=True, text=True, encoding='utf-8', timeout=20,
                                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        if result.returncode:
            raise ValueError(result.stderr.strip() or 'Endpoint enumeration failed')
        return json.loads(result.stdout)


class EndpointMonitor:
    def __init__(self, run, endpoint_id, max_seconds=180, on_exit=None, expected_name=None):
        self.root, self.manifest = load(run)
        if not endpoint_id or type(max_seconds) is not int or not 1 <= max_seconds <= 180:
            raise ValueError('Explicit endpoint id and 1–180 seconds required')
        if any(a['role'] == ROLE for a in self.manifest['artifacts']):
            raise ValueError('Source level history already exists; use a new run')
        self.endpoint_id, self.max_seconds, self.on_exit = endpoint_id, max_seconds, on_exit
        self.expected_name = expected_name
        self.folder = self.root / ('levels-' + uuid.uuid4().hex[:8])
        self.path = self.folder / 'events.jsonl'
        self.ready, self.finished = threading.Event(), threading.Event()
        self.proc = self.worker = self.error_log = None
        self.error = self.initial = self.terminal = self.artifact = None
        self.stop_requested = False

    def start(self):
        self.folder.mkdir()
        config = self.folder / 'config.json'
        save(config, dict(action='watch', runId=self.manifest['runId'], endpointId=self.endpoint_id, maxSeconds=self.max_seconds))
        self.error_log = (self.folder / 'stderr.log').open('w', encoding='utf-8')
        try:
            self.proc = subprocess.Popen(command(config), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                         stderr=self.error_log, text=True, encoding='utf-8',
                                         creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            self.worker = threading.Thread(target=self._read, daemon=True)
            self.worker.start()
            if not self.ready.wait(20) or self.error or not self.initial:
                raise ValueError(self.error or 'Endpoint observer did not persist readiness')
            if self.expected_name and self.initial['name'] != self.expected_name:
                raise ValueError('Observed endpoint name does not match the selected PCM source')
            with edit_run(self.root) as (_, manifest):
                prior = manifest['routing'].get('sourceEndpointId')
                if prior and prior != self.endpoint_id:
                    raise ValueError('Run is already bound to a different source endpoint')
                manifest['routing']['sourceEndpointId'] = self.endpoint_id
            return self
        except BaseException as error:
            self.error = self.error or str(error) or type(error).__name__
            self.close()
            raise

    def _read(self):
        sequence = 0
        try:
            with self.path.open('x', encoding='utf-8') as handle:
                for line in self.proc.stdout:
                    # Preserve the exact received line before parsing; readiness follows fsync.
                    handle.write(line); handle.flush(); os.fsync(handle.fileno())
                    row = json.loads(line)
                    validate_row(row, self.manifest['runId'], self.endpoint_id, sequence)
                    sequence += 1
                    if sequence > 50000:
                        raise ValueError('Endpoint event limit exceeded')
                    if row['event'] == 'ready':
                        self.initial = row; self.ready.set()
                    if row['event'] == 'stopped':
                        self.terminal = row
            if self.proc.wait() != 0 or not self.terminal or self.terminal.get('error'):
                raise ValueError((self.terminal or {}).get('error') or 'Endpoint observer exited without clean closure')
        except (ValueError, OSError, KeyError, TypeError, AttributeError) as error:
            self.error = str(error)
        finally:
            self.ready.set(); self.finished.set()
            if self.on_exit:
                self.on_exit(self.error)

    def request_stop(self):
        if self.proc and self.proc.poll() is None and not self.stop_requested:
            self.stop_requested = True
            try:
                self.proc.stdin.write('stop\n'); self.proc.stdin.flush()
            except (BrokenPipeError, OSError):
                pass

    def close(self):
        if self.artifact:
            return self.artifact
        self.request_stop()
        if self.worker:
            self.worker.join(timeout=10)
        if self.proc:
            if self.proc.poll() is None:
                self.proc.kill(); self.proc.wait(timeout=5)
                self.error = 'Endpoint observer needed termination; history incomplete'
            if self.worker:
                self.worker.join(timeout=3)
            self.proc.stdin.close(); self.proc.stdout.close()
        if self.error_log:
            self.error_log.close()
        if self.path.is_file():
            # Commit the copied evidence and collector failure together; a complete-looking
            # last line must not hide a failed fsync or forced process termination.
            with edit_run(self.root) as (root, manifest):
                artifact = _attach(root, manifest, self.path, ROLE, FORMAT)
                artifact['collectionStatus'] = 'failed' if self.error or not self.terminal else 'closed'
                artifact['collectionError'] = self.error
            self.artifact = artifact
        save(self.folder / 'status.json', {'status': 'failed' if self.error or not self.terminal else 'closed',
                                         'error': self.error, 'artifact': self.artifact})
        return self.artifact


def validate_row(row, run_id, endpoint_id, sequence):
    if (row.get('schemaVersion') != 1 or row.get('runId') != run_id or row.get('endpointId') != endpoint_id or
            type(row.get('sequence')) is not int or row['sequence'] != sequence):
        raise ValueError('Endpoint history identity or sequence mismatch')
    if row.get('event') not in ('ready', 'heartbeat', 'volume-change', 'device-state', 'default-capture-changed', 'stopped'):
        raise ValueError('Unknown endpoint event')
    seconds(row['observedAt'])
    if type(row.get('elapsedMs')) not in (int, float) or not math.isfinite(row['elapsedMs']) or row['elapsedMs'] < 0:
        raise ValueError('Invalid observer elapsed time')
    snapshot = row.get('state') if row['event'] in ('ready', 'stopped') else None
    for state in (snapshot, row.get('notification'), row.get('laterReadback')):
        if state is None:
            continue
        if not isinstance(state, dict):
            raise ValueError('Invalid endpoint state')
        scalar = state.get('masterScalar')
        channels = state.get('channelScalars')
        if (type(scalar) not in (int, float) or not math.isfinite(scalar) or not 0 <= scalar <= 1 or
                type(state.get('muted')) is not bool or not isinstance(channels, list) or not 1 <= len(channels) <= 32 or
                any(type(v) not in (int, float) or not math.isfinite(v) or not 0 <= v <= 1 for v in channels)):
            raise ValueError('Invalid endpoint level values')
        if state is not row.get('notification'):
            db, channel_db = state.get('masterDb'), state.get('channelDb')
            if (type(db) not in (int, float) or not math.isfinite(db) or not isinstance(channel_db, list) or
                    len(channel_db) != len(channels) or any(type(v) not in (int, float) or not math.isfinite(v) for v in channel_db)):
                raise ValueError('Invalid endpoint dB readback')
            if seconds(state['sampledFromUtc']) > seconds(state['sampledToUtc']):
                raise ValueError('Invalid readback time range')
    if row['event'] == 'volume-change':
        notification = row['notification']
        uuid.UUID(notification['eventContext'])
        if notification.get('actorProcessId') is not None:
            raise ValueError('Notification context is not process attribution')


def summarize(rows, manifest):
    if not rows:
        raise ValueError('Empty endpoint history')
    endpoint = manifest['routing'].get('sourceEndpointId')
    if not endpoint:
        raise ValueError('Run has no explicit source endpoint binding')
    for i, row in enumerate(rows):
        validate_row(row, manifest['runId'], endpoint, i)
    if (rows[0]['event'] != 'ready' or rows[-1]['event'] != 'stopped' or
            sum(r['event'] == 'ready' for r in rows) != 1 or sum(r['event'] == 'stopped' for r in rows) != 1):
        raise ValueError('Endpoint history has no unique complete lifecycle')
    first, last = rows[0], rows[-1]
    reasons = []
    if (last.get('error') or last.get('callbacksUnregistered') is not True or not first.get('state') or not last.get('state') or
            last.get('reason') not in ('deadline', 'stop-request')):
        reasons.append('observer-did-not-close-cleanly')
    if any(r.get('laterReadbackError') or r['event']=='device-state' and r.get('state') != 1 for r in rows):
        reasons.append('endpoint-invalidated-or-readback-failed')
    health = [r for r in rows if r['event'] in ('ready', 'heartbeat', 'stopped')]
    gaps = [(b['elapsedMs']-a['elapsedMs']) / 1000 for a,b in zip(health, health[1:])]
    max_gap = max(gaps, default=0)
    if max_gap > 2.5 or any(g < 0 for g in gaps):
        reasons.append('observer-health-gap')
    start = seconds(first['observedAt'])
    if any(abs((seconds(r['observedAt'])-start)*1000-(r['elapsedMs']-first['elapsedMs'])) > 250 for r in health):
        reasons.append('wall-clock-discontinuity')
    covered_from = first.get('state', {}).get('sampledToUtc')
    covered_to = last.get('listeningEndedAt')
    window = manifest['window']
    if not window.get('startUtc') or not window.get('endUtc'):
        reasons.append('measurement-window-not-set')
    elif (not covered_from or not covered_to or not seconds(covered_from) <= seconds(window['startUtc']) < seconds(window['endUtc']) <= seconds(covered_to)):
        reasons.append('measurement-window-not-covered')
    notifications = [r for r in rows if r['event']=='volume-change']
    def values(s):
        return (s.get('masterScalar'),s.get('muted'),s.get('channelScalars'))
    states = [first.get('state') or {}] + [r['notification'] for r in notifications] + [last.get('state') or {}]
    variation = any(values(s) != values(states[0]) for s in states[1:])
    readbacks = [s for s in (first.get('state'), last.get('state'), *[r.get('laterReadback') for r in notifications]) if s]
    db = [s['masterDb'] for s in readbacks if type(s.get('masterDb')) in (int, float) and math.isfinite(s['masterDb'])]
    in_window = ([r for r in notifications if seconds(window['startUtc']) <= seconds(r['observedAt']) <= seconds(window['endUtc'])]
                 if window.get('startUtc') and window.get('endUtc') else None)
    return {'status': 'covered' if not reasons else 'incomplete', 'reasons': reasons,
            'endpointId': endpoint, 'name': first.get('name'), 'notificationCount': len(notifications),
            'measurementWindowNotificationCount': len(in_window) if in_window is not None else None,
            'levelVariationObserved': variation or len(set(db)) > 1,
            'readbackDbRange': [min(db), max(db)] if db else None,
            'initial': first.get('state'), 'final': last.get('state'),
            'maxHealthGapSeconds': max_gap, 'coveredFromUtc': covered_from, 'coveredToUtc': covered_to,
            'events': notifications, 'actorProcessId': None,
            'deviceEvents': [r for r in rows if r['event'] in ('device-state', 'default-capture-changed')],
            'limitation': 'Notification time is observer receipt time. Event context is not a process id. Scalars are not dB; later readback can reflect a newer state. No-change observed is not proof of an unchanged audio processing chain.'}


def analyze(root, manifest):
    candidates = [a for a in manifest['artifacts'] if a['role'] == ROLE]
    if not candidates:
        return {'status': 'unavailable', 'reasons': ['source-level-history-not-collected']}
    try:
        if len(candidates) != 1 or candidates[0].get('format') != FORMAT:
            raise ValueError('Expected one Windows source-level history per run')
        if candidates[0].get('collectionStatus') == 'failed' or candidates[0].get('collectionError'):
            raise ValueError(candidates[0].get('collectionError') or 'Endpoint collector did not finish cleanly')
        path = evidence_path(root, candidates[0])
        if path.stat().st_size > 32_000_000:
            raise ValueError('Endpoint history exceeds size limit')
        rows = [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines() if line.strip()]
        return {'artifactId': candidates[0]['id'], **summarize(rows, manifest)}
    except (ValueError, OSError, KeyError, TypeError, AttributeError) as error:
        return {'status': 'incomplete', 'reasons': [str(error)]}


def watch(run, endpoint_id, max_seconds):
    monitor = EndpointMonitor(run, endpoint_id, max_seconds).start()
    print('Endpoint level observer ready and persisted. Type stop to finish early.', flush=True)
    def read_stop():
        import sys
        for line in sys.stdin:
            if line.strip() == 'stop':
                monitor.request_stop(); return
    threading.Thread(target=read_stop, daemon=True).start()
    try:
        monitor.finished.wait(max_seconds + 25)
    except KeyboardInterrupt:
        monitor.request_stop()
    finally:
        monitor.close()
    if monitor.error:
        raise ValueError(monitor.error)
    root, manifest = load(run)
    return analyze(root, manifest)
