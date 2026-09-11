"""Explicit-device Windows PCM capture; stdin 'stop' ends both streams gracefully.

No microphone opens on import, init, doctor or analysis. A synthetic self-check
uses lavfi generators, never hardware. Progress is fsynced as it arrives.
"""
import json
import os
import queue
import subprocess
import sys
import threading
import uuid

from .audio import reference_engine
from .bundle import attach, load, mark, save, utc
from .levels import EndpointMonitor, list_endpoints


def capture(run, source_device=None, receiver_device=None, synthetic_seconds=None, *, source_endpoint_id=None, source_only=False):
    root, manifest = load(run)
    if synthetic_seconds is not None and (source_device or receiver_device or source_endpoint_id):
        raise ValueError('Synthetic capture cannot name real audio endpoints')
    if synthetic_seconds is None and (os.name != 'nt' or not source_device or not source_endpoint_id or not source_only and not receiver_device):
        raise ValueError('Windows capture requires explicit source name/id and receiver name or --source-only')
    if source_only and receiver_device:
        raise ValueError('--source-only cannot include a receiver device')
    if synthetic_seconds is None and source_device == receiver_device and not source_only:
        raise ValueError('Source and receiver must use distinct recording endpoints')
    selected = [('source-audio', source_device)] + ([] if source_only else [('receiver-audio', receiver_device)])
    if any(a['role'] in dict(selected) for a in manifest['artifacts']):
        raise ValueError('Audio is already attached; create another run instead of replacing it')
    if synthetic_seconds is None:
        endpoints = list_endpoints()
        matches = [e for e in endpoints if e['name'] == source_device]
        if len(matches) != 1 or matches[0]['endpointId'] != source_endpoint_id:
            raise ValueError('Source name/id is missing or ambiguous; do not guess a DirectShow endpoint')
    folder = root / ('capture-' + uuid.uuid4().hex[:8])
    folder.mkdir()
    messages, workers, processes, log_files = queue.Queue(), [], [], []
    results, failed, stopped, monitor = {}, None, False, None

    def progress(proc, role):
        for raw in proc.stdout:
            key, _, value = raw.strip().partition('=')
            if key == 'out_time_us':
                try:
                    messages.put(('progress', role, int(value) / 1_000_000))
                except ValueError:
                    pass
        messages.put(('exit', role, proc.wait()))

    def read_stop():
        for line in sys.stdin:
            if line.strip().lower() == 'stop':
                messages.put(('stop', '', 0))
                return
        messages.put(('stop', '', 0))

    try:
        if synthetic_seconds is None:
            monitor = EndpointMonitor(run, source_endpoint_id, expected_name=source_device,
                                      on_exit=lambda error: messages.put(('level-exit', 'source-levels', error))).start()
        mark(run, 'audio-capture-started')
        for index, (role, device) in enumerate(selected):
            output = folder / (role + '.wav')
            cmd = [reference_engine().FFMPEG, '-hide_banner', '-loglevel', 'error', '-n']
            if synthetic_seconds is not None:
                cmd += ['-f', 'lavfi', '-i', f'sine=frequency={440 + index * 100}:sample_rate=48000',
                        '-t', str(synthetic_seconds)]
            else:
                cmd += ['-f', 'dshow', '-i', 'audio=' + device]
            cmd += ['-vn', '-c:a', 'pcm_s16le', '-progress', 'pipe:1', '-stats_period', '0.5', '-nostats', str(output)]
            error_log = (folder / (role + '.log')).open('w', encoding='utf-8')
            log_files.append(error_log)
            flags = (subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP) if os.name == 'nt' else 0
            proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=error_log,
                                    text=True, encoding='utf-8', errors='replace', creationflags=flags)
            processes.append((role, proc, output))
            worker = threading.Thread(target=progress, args=(proc, role), daemon=True)
            worker.start()
            workers.append(worker)
        if synthetic_seconds is None:
            threading.Thread(target=read_stop, daemon=True).start()
            print('PCM capture starting. Type stop then Enter to finish. RTP collection is separate.', flush=True)
        done, ready = set(), False
        with (folder / 'progress.jsonl').open('x', encoding='utf-8') as health:
            while len(done) < len(processes):
                try:
                    kind, role, value = messages.get(timeout=30)
                except queue.Empty:
                    failed = 'No capture progress for 30 seconds; speech readiness is invalid'
                    break
                if kind == 'stop':
                    stopped = True
                    break
                if kind == 'level-exit':
                    failed = value or 'Source level observer ended before PCM capture'
                    break
                health.write(json.dumps(dict(at=utc(), event=kind, role=role, value=value)) + '\n')
                health.flush()
                os.fsync(health.fileno())
                if kind == 'exit':
                    done.add(role)
                    if value != 0 or synthetic_seconds is None:
                        failed = f'{role} ended unexpectedly (exit {value}); stop the experiment'
                        break
                else:
                    results[role] = value
                    if not ready and len(results) == len(selected) and min(results.values()) >= 1:
                        ready = True
                        print('Selected PCM streams are progressing. This does not certify RTP history or device routing.', flush=True)
    except KeyboardInterrupt:
        stopped = True
    except Exception as error:
        failed = str(error)
    finally:
        for role, proc, output in processes:
            try:
                if proc.poll() is None:
                    try:
                        proc.stdin.write('q\n')
                        proc.stdin.flush()
                    except (BrokenPipeError, OSError):
                        pass
                    try:
                        proc.wait(timeout=8)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                        proc.wait(timeout=5)
                        failed = failed or 'Capture needed termination; WAV completeness is not guaranteed'
            except Exception as error:
                failed = failed or f'{role} cleanup failed: {error}'
        for worker in workers:
            worker.join(timeout=3)
        for handle in log_files:
            handle.close()
        if monitor:
            try:
                monitor.close()
                failed = failed or monitor.error
            except Exception as error:
                failed = failed or f'Endpoint observer closure failed: {error}'
    if not failed and len(processes) == len(selected) and all(proc.returncode == 0 and path.is_file() and path.stat().st_size > 44 for _, proc, path in processes):
        for role, proc, output in processes:
            attach(run, output, role)
    else:
        failed = failed or 'Capture did not finish cleanly; partial files retained for diagnosis'
    status = dict(status='failed' if failed else 'captured', synthetic=synthetic_seconds is not None,
                  stoppedByUser=stopped, error=failed, lastProgressSeconds=results,
                  sourceDevice=source_device, receiverDevice=receiver_device, sourceOnly=source_only,
                  sourceEndpointId=source_endpoint_id, levelArtifactId=monitor.artifact['id'] if monitor and monitor.artifact else None)
    save(folder / 'status.json', status)
    mark(run, 'audio-capture-failed' if failed else 'audio-capture-finalized')
    if failed:
        raise ValueError(failed)
    return status
