"""Single run report and cross-client comparison without claiming platform equivalence."""
import json
from pathlib import Path

from . import audio, rtp, levels
from .bundle import evidence_path, load, save, technology, utc

TECH_FIELDS = ('mediaEngine', 'captureApi', 'audioWorklet', 'nativeUplinkCodec',
               'noiseSuppression', 'echoCancellation', 'autoGainControl', 'musicMode', 'dtx', 'fec', 'frameDuration')


def analyze(run):
    root, manifest = load(run)
    # Reject tampering before any metric is calculated or any report is replaced.
    for artifact in manifest['artifacts']:
        evidence_path(root, artifact)
    transport = rtp.analyze(root, manifest['artifacts'], manifest['window'])
    pcm = audio.analyze(root, manifest['artifacts'])
    tech = technology(root, manifest['artifacts'])
    source_levels = levels.analyze(root, manifest)
    fields = {item['field'] for item in tech['observations']}
    tech['unavailable'] = [field for field in TECH_FIELDS if field not in fields]
    coverage = {
        'receiverRtp': any(s['endpoint'] == 'receiver' and s['direction'] == 'inbound' and s['coverage']['status'] == 'covered' for s in transport['streams']),
        'senderRtp': any(s['endpoint'] == 'sender' and s['direction'] == 'outbound' and s['coverage']['status'] == 'covered' for s in transport['streams']),
        'sourcePcm': 'source-audio' in pcm['files'],
        'sourceLevelHistory': source_levels['status'] == 'covered',
        'receiverPcm': 'receiver-audio' in pcm['files'],
        'referenceSegments': bool(pcm['segments']) and all(s['status'] == 'measured' for s in pcm['segments']),
        'technologyEvidence': bool(tech['observations']),
        'routingDeclaredVerified': manifest['routing'].get('verified') is True,
        'clientMetadata': all(endpoint.get(key) for endpoint in manifest['endpoints'].values() for key in ('surface', 'os', 'version', 'device')),
    }
    result = dict(schemaVersion=1, runId=manifest['runId'], generatedAt=utc(),
                  platform=manifest['platform'], mode=manifest['mode'], endpoints=manifest['endpoints'],
                  window=manifest['window'], routing=manifest['routing'], coverage=coverage,
                  settingsContext=manifest.get('settingsContext', {'basis': 'unverified', 'defaultEvidence': None, 'overrides': {}}),
                  transport=transport, audio=pcm, technology=tech, sourceLevels=source_levels,
                  evidence=manifest['artifacts'],
                  micprobeDecision={'status': 'review-required',
                                    'use': 'Compare measured client/mode behavior with local scenario requirements.',
                                    'automaticPresetChanges': False, 'platformEquivalence': 'not-established'})
    save(root / 'report.json', result)
    (root / 'report.md').write_text(render(result), encoding='utf-8')
    return result


def cell(value):
    if value is None:
        return '—'
    if isinstance(value, float):
        return f'{value:.3f}'
    return str(value).replace('|', '\\|').replace('\n', ' ')


def render(report):
    rows = [f'# {report["platform"]} — {report["mode"]}', '',
            f'Deney: `{report["runId"]}`. Otomatik platform eşdeğerliği veya profil değişikliği yapılmadı.', '',
            f'Ayar koşulu: {cell(report["settingsContext"]["basis"])}. Varsayılan kanıtı: {cell(report["settingsContext"].get("defaultEvidence"))}. '
            'Gözlenen ayarlar veya yerel profil, üreticinin varsayılanı sayılmaz.', '',
            '## Kanıt kapsamı', '', '| Alan | Durum |', '|---|---|']
    rows += [f'| {key} | {"mevcut" if value else "eksik / doğrulanmadı"} |' for key, value in report['coverage'].items()]
    rows += ['', '## Aktarım', '',
             '| Uç / yön / akış | Codec | Kapsam | RTP kbit/s | Kayıp % | Jitter ortanca ms |', '|---|---|---|---:|---:|---:|']
    for stream in report['transport']['streams']:
        codec = ', '.join(c.get('mimeType', '?') for c in stream['codecs'])
        rows.append('| ' + ' | '.join(map(cell, (f'{stream["endpoint"]}/{stream["direction"]}/{stream["streamId"]}', codec,
                    stream['coverage']['status'] + ': ' + ', '.join(stream['coverage']['reasons']),
                    stream['payloadKbps'], stream['packetLossPercent'], (stream['jitterMs'] or {}).get('median')))) + ' |')
    rows += ['', 'RTP değerleri yalnız belirtilen uç/yön ve kapsanan zaman aralığına aittir. Codec saat hızı akustik bant genişliği değildir. '
             'Eksik zaman aralığında bitrate boş kalır; hedef bitrate ve kümülatif sayaçlar JSON içinde ayrıca korunur.', '',
             '## Kaydedilmiş ses', '', '| Rol | Süre s | RMS dBFS | Peak dBFS | LUFS-I | Kanal içeriği |', '|---|---:|---:|---:|---:|---|']
    for role, data in report['audio']['files'].items():
        m = data['metrics']
        rows.append('| ' + ' | '.join(map(cell, (role, data['durationSeconds'], m['rmsDb'], m['peakDb'], m['lufs']['integrated'], m['channelLayout']))) + ' |')
    rows += ['', 'JSON: true peak, sample saturation, dinamik aralık, spektrum, kanal ölçümleri ve eşleştirme kanıtları. '
             f'Analiz sürümü: {cell(report["audio"].get("analysisRevision"))}.', '',
             '## Referans bölümleri', '', '| Bölüm | Durum | Karşılaştırma | Kazanç dB | Kenar kırpma s | Eksik bilgi |', '|---|---|---|---:|---:|---|']
    for segment in report['audio']['segments']:
        reason = segment.get('unavailable') or segment.get('gainUnavailableReason') or '—'
        rows.append('| ' + ' | '.join(map(cell, (segment['name'], segment['status'], segment['comparisonBasis'],
                                                segment['gainDb'], segment.get('edgeTrimSeconds', 0), reason))) + ' |')
    rows += ['', 'Kenar kırpma her iki uçtan çıkarılan süreyi belirtir; ölçülen dosya aralıkları JSON içindedir. '
             'Kısmi eşleşme doğrulanmayan bölümlere taşınmaz. Ses örnekleri esnetilmez veya normalize edilmez. '
             'Bölüm farkları gözlenen kayıt zincirine aittir; tek başına NS/AGC algoritmasını veya AEC başarısını tanımlamaz.', '',
             '## Teknoloji kanıtları', '']
    rows += [f'- {cell(item["scope"])} / {cell(item["field"])}: {cell(item["value"])} ({item["status"]}; kanıt `{item["artifactId"]}`, {cell(item["locator"])})' for item in report['technology']['observations']]
    source_levels = report['sourceLevels']
    rows += ['', 'Bilinmeyen: ' + ', '.join(report['technology']['unavailable']), '', '## Windows kaynak seviyesi', '',
             f'Durum: {cell(source_levels["status"])}. Eksik: {cell(", ".join(source_levels.get("reasons", [])) or None)}. '
             f'Toplam bildirim: {cell(source_levels.get("notificationCount"))}; ölçüm penceresinde: {cell(source_levels.get("measurementWindowNotificationCount"))}. '
             f'İzleyici açıkken seviye/mute değişimi gözlendi: {cell(source_levels.get("levelVariationObserved"))}. '
             f'Okunan dB aralığı: {cell(source_levels.get("readbackDbRange"))}.', '',
             'Bu kayıt mikrofon sesini kaydetmez veya seviyeyi değiştirmez. Olay kimliği değişikliği yapan uygulamayı tanımlamaz. '
             'Bildirimin ardından okunan dB değeri daha sonraki bir durumu gösterebilir; bildirimdeki ölçek değeri dB’ye çevrilmez.', '',
             '## Eksikler / sınırlamalar', '']
    rows += [f'- {key}: {value}' for key, value in report['audio']['unknowns'].items()]
    for category in ('transport', 'audio'):
        rows += [f'- {category}: {cell(error)}' for error in report[category]['errors']]
    rows += [f'- Reddedilen teknoloji kanıtı: {cell(item.get("field"))} — {cell(item["reason"])}' for item in report['technology']['rejected']]
    return '\n'.join(rows) + '\n'


def compare(runs, output):
    reports = []
    for run in runs:
        root, current = load(run)
        report = json.loads((root / 'report.json').read_text(encoding='utf-8'))
        if report.get('audio', {}).get('analysisRevision') != audio.ANALYSIS_REVISION:
            raise ValueError('Analysis revision changed; regenerate its report before comparing')
        if (report['runId'] != current['runId'] or report['evidence'] != current['artifacts'] or
                any(report[key] != current[key] for key in ('window', 'platform', 'mode', 'endpoints', 'routing')) or
                report.get('settingsContext', {'basis': 'unverified', 'defaultEvidence': None, 'overrides': {}}) != current.get('settingsContext', {'basis': 'unverified', 'defaultEvidence': None, 'overrides': {}})):
            raise ValueError('Run changed after analysis; regenerate its report before comparing')
        for artifact in current['artifacts']:
            evidence_path(root, artifact)
        reports.append(report)
    output = Path(output)
    if output.exists():
        raise ValueError('Comparison output already exists; choose a new file')
    rows = ['# Platform / istemci karşılaştırması', '',
            'Aynı platform adı veya codec eşdeğerlik kanıtı değildir. Referans, alıcı, mod ve rota farklıysa sonuçlar doğrudan kıyaslanmaz.', '',
            '| Platform | Gönderici | Sürüm | Mod | Ayar dayanağı | Alıcı RTP kbit/s | Kaynak / alıcı PCM | Referans hash |', '|---|---|---|---|---|---:|---|---|']
    for report in reports:
        streams = [s for s in report['transport']['streams'] if s['endpoint'] == 'receiver' and s['direction'] == 'inbound']
        rates = ', '.join(cell(s['payloadKbps']) for s in streams) or '—'
        reference = next((a['sha256'][:12] for a in report['evidence'] if a['role'] == 'reference-audio'), '—')
        endpoint = report['endpoints']['sender']
        rows.append('| ' + ' | '.join(map(cell, (report['platform'], endpoint['surface'], endpoint['version'], report['mode'],
                                                report.get('settingsContext', {}).get('basis', 'unverified'), rates, f'{report["coverage"]["sourcePcm"]} / {report["coverage"]["receiverPcm"]}', reference))) + ' |')
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text('\n'.join(rows) + '\n', encoding='utf-8')
    return output
