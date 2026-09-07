#!/usr/bin/env python3
"""Unpacks physical-run bundles (<id>.bundle.json downloaded by the page) into audio + report files
and maintains the manifest consumed by reference-audio-metrics.py.

  python scripts/real-capture-unpack.py --downloads %USERPROFILE%\\Downloads --out .tmp/real-capture/<date>/physical
"""
import argparse
import base64
import glob
import json
import os
import shutil

EXT = {'audio/wav': '.wav', 'audio/ogg': '.ogg', 'audio/webm': '.webm', 'audio/mp4': '.m4a', 'audio/mpeg': '.mp3'}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--downloads', default=os.path.join(os.path.expanduser('~'), 'Downloads'))
    parser.add_argument('--out', required=True)
    parser.add_argument('--keep', action='store_true', help='leave the bundle in Downloads instead of moving it')
    args = parser.parse_args()
    os.makedirs(args.out, exist_ok=True)
    manifest_path = os.path.join(args.out, 'manifest.json')
    manifest = json.load(open(manifest_path, encoding='utf-8')) if os.path.exists(manifest_path) else \
        {'layer': 'physical', 'sourceWav': None, 'entries': []}
    for bundle_path in sorted(glob.glob(os.path.join(args.downloads, '*.bundle*.json'))):
        with open(bundle_path, encoding='utf-8') as handle:
            bundle = json.load(handle)
        entry_id = bundle['id']
        profile = (bundle.get('report') or {}).get('profile', {}).get('id') or 'unknown'
        ext = EXT.get(bundle['audio']['type'].split(';')[0].strip(), '.bin')
        audio_name = f'{entry_id}_{profile}{ext}'
        report_name = f'{entry_id}.report.json'
        audio_bytes = base64.b64decode(bundle['audio']['base64'])
        with open(os.path.join(args.out, audio_name), 'wb') as handle:
            handle.write(audio_bytes)
        with open(os.path.join(args.out, report_name), 'w', encoding='utf-8') as handle:
            json.dump({k: v for k, v in bundle.items() if k != 'audio'} | {'audioFile': audio_name, 'audioBytes': len(audio_bytes)},
                      handle, ensure_ascii=False, indent=2)
        manifest['entries'] = [e for e in manifest['entries'] if e['id'] != entry_id]
        manifest['entries'].append({'id': entry_id, 'profile': profile, 'scenario': bundle.get('scenario', ''), 'audio': audio_name,
                                    'report': report_name, 'expectFindings': bundle.get('expectFindings') or [],
                                    'notes': bundle.get('originalFilename', '')})
        print(f'{entry_id}: {audio_name} ({len(audio_bytes)} bytes, matches report: '
              f"{len(audio_bytes) == (bundle.get('report') or {}).get('recording', {}).get('blobSize')}) + {report_name}")
        if not args.keep:
            shutil.move(bundle_path, os.path.join(args.out, os.path.basename(bundle_path)))
    manifest['entries'].sort(key=lambda e: e['id'])
    with open(manifest_path, 'w', encoding='utf-8') as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)
    print(f"manifest: {manifest_path} ({len(manifest['entries'])} entries)")


if __name__ == '__main__':
    main()
