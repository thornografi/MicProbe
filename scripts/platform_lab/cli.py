import argparse
import importlib.util
import json
import os
import subprocess
import sys
import uuid

from . import bundle, rtp


def ingest(run, role, stream):
    """Durable sink for an authorized adapter, not an adapter to a hidden browser page."""
    root, manifest = bundle.load(run)
    path = root / 'raw' / ('live-' + uuid.uuid4().hex + '.jsonl')
    count = 0
    with path.open('x', encoding='utf-8') as handle:
        for line in stream:
            if not line.strip():
                continue
            envelope = json.loads(line)
            if envelope.get('runId') != manifest['runId']:
                raise ValueError('Incoming sample belongs to a different run')
            sample = rtp.validate_sample(envelope['sample'])
            handle.write(json.dumps(sample, allow_nan=False) + '\n')
            handle.flush()
            os.fsync(handle.fileno())
            count += 1
    if not count:
        raise ValueError('No statistics arrived; speech readiness is not established')
    return bundle.attach(run, path, role, 'normalized-rtp')


def doctor():
    result = {'python': sys.version.split()[0],
              'dependencies': {name: importlib.util.find_spec(name) is not None for name in ('numpy', 'scipy')},
              'hardwareCaptureTested': False, 'platformAdaptersConnected': False}
    if all(result['dependencies'].values()):
        try:
            from .audio import reference_engine
            engine = reference_engine()
            result['ffmpeg'] = subprocess.run([engine.FFMPEG, '-version'], capture_output=True, text=True, check=True).stdout.splitlines()[0]
            result['ffprobe'] = engine.FFPROBE
        except (ValueError, OSError, subprocess.SubprocessError) as error:
            result['error'] = str(error)
    return result


def main():
    parser = argparse.ArgumentParser(description='Collect one evidence bundle per platform/client/mode and analyze it together.')
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('doctor', help='Check local analysis runtime; never opens a device')
    sub.add_parser('list-endpoints', help='List active Windows capture endpoint ids; does not open audio')
    command = sub.add_parser('watch-levels', help='Persist source endpoint volume events; never changes a level or opens audio')
    command.add_argument('run')
    command.add_argument('--endpoint-id', required=True)
    command.add_argument('--seconds', type=int, default=180)
    command = sub.add_parser('init')
    command.add_argument('run')
    command.add_argument('--platform', choices=bundle.PLATFORMS, required=True)
    command.add_argument('--surface', choices=bundle.SURFACES, required=True)
    command.add_argument('--mode', default='normal-speech')
    command = sub.add_parser('attach')
    command.add_argument('run')
    command.add_argument('source')
    command.add_argument('--role', choices=bundle.ROLES, required=True)
    command.add_argument('--format', choices=('chrome-dump', 'normalized-rtp', 'windows-endpoint-levels'))
    command = sub.add_parser('mark')
    command.add_argument('run')
    command.add_argument('event')
    command.add_argument('--at', help='ISO timestamp with timezone; omit to use current UTC')
    command = sub.add_parser('ingest', help='Append run-bound normalized RTP samples from an authorized adapter on stdin')
    command.add_argument('run')
    command.add_argument('--role', choices=('sender-stats', 'receiver-stats'), required=True)
    command = sub.add_parser('reference', help='Build reusable stimulus from an existing speech file; does not play it')
    command.add_argument('--speech', required=True)
    command.add_argument('--output', required=True)
    command = sub.add_parser('capture-audio', help='Record two explicit Windows input endpoints; type stop to finish')
    command.add_argument('run')
    command.add_argument('--source-device')
    command.add_argument('--receiver-device')
    command.add_argument('--source-endpoint-id', help='Explicit id from list-endpoints; mandatory for real capture')
    command.add_argument('--source-only', action='store_true', help='Capture only source PCM when receiver is collected separately')
    command.add_argument('--synthetic-seconds', type=float, help='Hardware-free FFmpeg integration check only')
    command = sub.add_parser('analyze')
    command.add_argument('run')
    command = sub.add_parser('import-browser', help='Import one stopped, run-bound PCM/getStats export from an authorized application page')
    command.add_argument('run')
    command.add_argument('source')
    command.add_argument('--capture-point', choices=('receiver', 'sender-outbound', 'browser-input'), default='receiver')
    command = sub.add_parser('import-micprobe', help='Import both stopped PCM/getStats taps from the local development lab')
    command.add_argument('run')
    command.add_argument('source')
    command = sub.add_parser('compare')
    command.add_argument('runs', nargs='+')
    command.add_argument('--output', required=True)
    args = parser.parse_args()
    try:
        if args.command == 'doctor':
            result = doctor()
        elif args.command == 'list-endpoints':
            from .levels import list_endpoints
            result = list_endpoints()
        elif args.command == 'watch-levels':
            from .levels import watch
            result = watch(args.run, args.endpoint_id, args.seconds)
        elif args.command == 'init':
            result = bundle.init(args.run, args.platform, args.surface, args.mode)
        elif args.command == 'attach':
            result = bundle.attach(args.run, args.source, args.role, args.format)
        elif args.command == 'mark':
            bundle.mark(args.run, args.event, args.at)
            result = {'marked': args.event}
        elif args.command == 'ingest':
            result = ingest(args.run, args.role, sys.stdin)
        elif args.command == 'reference':
            from .audio import make_reference
            result = {'referenceDirectory': str(make_reference(args.speech, args.output))}
        elif args.command == 'capture-audio':
            from .capture import capture
            if args.synthetic_seconds is not None and not 0.1 <= args.synthetic_seconds <= 10:
                raise ValueError('Synthetic check duration must be 0.1–10 seconds')
            result = capture(args.run, args.source_device, args.receiver_device, args.synthetic_seconds,
                             source_endpoint_id=args.source_endpoint_id, source_only=args.source_only)
        elif args.command == 'import-browser':
            from pathlib import Path
            from .browser_capture import import_capture
            result = import_capture(args.run, Path(args.source), args.capture_point)
        elif args.command == 'import-micprobe':
            from pathlib import Path
            from .browser_capture import import_micprobe
            result = import_micprobe(args.run, Path(args.source))
        elif args.command == 'analyze':
            from .report import analyze
            report = analyze(args.run)
            result = {'runId': report['runId'], 'coverage': report['coverage'], 'report': str(bundle.load(args.run)[0] / 'report.md')}
        else:
            from .report import compare
            result = {'comparison': str(compare(args.runs, args.output))}
        print(json.dumps(bundle.clean(result), ensure_ascii=True, indent=2, allow_nan=False))
    except (ValueError, OSError, KeyError, TypeError, ImportError) as error:
        parser.exit(2, f'Platform Lab: {error}\n')
