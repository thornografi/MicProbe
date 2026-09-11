import test from 'node:test';
import assert from 'node:assert/strict';
import { PROFILES } from '../modules/Config.js';
import loopback from '../modules/LoopbackManager.js';
import { createRunSnapshot } from '../modules/RunSnapshot.js';
import builder from '../modules/DiagnosticReportBuilder.js';
import DeviceInfo from '../modules/DeviceInfo.js';

const sdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111 0\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;useinbandfec=1;usedtx=0;maxaveragebitrate=48000;stereo=1;sprop-stereo=1\r\na=rtpmap:0 PCMU/8000\r\n';
test('measured platform preferences replace only owned Opus parameters without duplicates', () => {
  const teams = loopback.setOpusBitrate(sdp, 32000, 1, PROFILES.teams.transport);
  assert.match(teams, /usedtx=1/);
  assert.match(teams, /maxaveragebitrate=32000/);
  assert.match(teams, /minptime=10;useinbandfec=1/);
  assert.equal((teams.match(/usedtx=/g) || []).length, 1);
  assert.match(teams, /;stereo=0;sprop-stereo=0/);
  const webex = loopback.setOpusBitrate(teams, 64000, 1, PROFILES.webex.transport);
  assert.match(webex, /usedtx=0;useinbandfec=1/);
  assert.equal((webex.match(/useinbandfec=/g) || []).length, 1);
  assert.match(webex, /a=rtpmap:0 PCMU\/8000/);
  const noFmtp = sdp.replace(/^a=fmtp:111.*\r\n/m, '');
  assert.match(loopback.setOpusBitrate(noFmtp, 32000, 1, { dtx: true }), /a=fmtp:111 .*usedtx=1/);
  assert.equal(loopback.setOpusBitrate('a=rtpmap:0 PCMU/8000\r\n', 32000, 1, { dtx: true }), 'a=rtpmap:0 PCMU/8000\r\n');
});

test('unmeasured platforms remain usable and leave unknown Opus preferences at browser defaults', () => {
  for (const id of ['discord', 'google-meet', 'whatsapp-call', 'telegram-call']) {
    const profile = PROFILES[id];
    assert.ok(profile.canTest && profile.values.encoder === 'mediarecorder', id);
    assert.equal(profile.evidence.basis, 'heuristic');
    assert.equal(profile.evidence.classification, 'local-approximation');
    assert.equal(profile.transport.dtx, null);
    assert.match(loopback.setOpusBitrate(sdp, profile.values.bitrate, 1, profile.transport), /useinbandfec=1;usedtx=0/);
  }
  assert.equal(PROFILES.zoom.evidence.clientCodec, null);
  assert.equal(PROFILES.zoom.transport.dtx, null);
  assert.equal(PROFILES['whatsapp-voice'].canRecord, true);
  assert.equal(PROFILES['telegram-voice'].canRecord, true);
  assert.equal(PROFILES['zoom-hifi'].values.ec, false, 'higher-bitrate music check stays available');
});

test('a report retains its original evidence and Opus requests across profile edits; missing history stays unknown', () => {
  const profile = structuredClone(PROFILES.teams);
  const snapshot = createRunSnapshot({ profile, requestedSettings: { bitrate: 32000 } });
  profile.transport.dtx = false;
  profile.evidence.summary = 'changed later';
  builder._runSnapshot = snapshot;
  builder._activeRunType = 'test';
  builder._lastLoopbackStats = null;
  assert.equal(builder._buildLoopback().requestedOpus.dtx, true);
  assert.equal(builder._buildLoopback().isDtxActive, null, 'request is not proof of transmitted DTX');
  assert.notEqual(builder._buildProfile().evidence.summary, profile.evidence.summary);
  builder._runSnapshot = { profileId: 'teams', requestedSettings: {} };
  assert.equal(builder._buildLoopback().requestedOpus, null);
  assert.equal(builder._buildProfile().evidence, null);
  builder._resetRunState();
});

test('technical preview separates input settings, RTP and file bitrate and clears stale measurements', () => {
  const elements = new Map();
  globalThis.document = { getElementById: id => {
    if (!elements.has(id)) elements.set(id, { textContent: '', title: '' });
    return elements.get(id);
  } };
  const info = new DeviceInfo();
  info._publishAccess = () => {};
  info.tryEnumerateWithoutPermission = () => {};
  info.updateStreamInfo({ getAudioTracks: () => [{ label: 'Mic', getSettings: () => ({ sampleRate: 44100 }) }] });
  assert.equal(info.sampleRateEl.textContent, '44.1 kHz');
  assert.equal(info.channelsEl.textContent, '--', 'missing channel count is not mono evidence');
  info.updateActualBitrate({ actualBitrate: 21500, senderCodec: { mimeType: 'audio/opus' } });
  assert.equal(info.actualBitrateEl.textContent, '22 kbps');
  assert.equal(info.codecEl.textContent, 'audio/opus');
  info._onProfileChanged({ values: PROFILES.raw.values });
  assert.equal(info.codecEl.textContent, '--');
  assert.equal(info.actualBitrateEl.textContent, '--');
  info.updateReportInfo({ run: { type: 'record' }, recording: { mimeType: 'audio/wav', actualBitrate: 768000 } });
  assert.equal(info.actualBitrateLabel.textContent, 'Measured file bitrate');
  assert.equal(info.codecEl.textContent, 'audio/wav');
  info.updateReportInfo({ run: { type: 'test' }, recording: { actualBitrate: 999999 }, loopback: {} });
  assert.equal(info.actualBitrateEl.textContent, '--', 'call file bytes must not fill missing RTP evidence');
  info.destroy();
});
