/**
 * DiagnosticReportBuilder - Yapilandirilmis diagnostik rapor olusturucu
 *
 * Test/kayit tamamlandiginda tum verileri birlestirip JSON rapor olusturur.
 * Bu rapor ileride AI evaluator'a beslenecek.
 *
 * Veri kaynaklari:
 * - AudioMetricsCollector (ses kalite metrikleri)
 * - ProfileController (profil ve constraint bilgileri)
 * - LogManager (sanity report, log istatistikleri)
 * - RECORDING_COMPLETED event (kayit verisi)
 * - LOOPBACK_STATS event (WebRTC istatistikleri)
 * - DeviceInfo DOM (cihaz bilgileri)
 * - navigator API (ortam bilgileri)
 */
import eventBus from './EventBus.js';
import { EVENTS, IS_DEV } from './constants.js';
import { log } from './utils.js';

class DiagnosticReportBuilder {
  constructor() {
    // Dependency injection ile set edilecek referanslar
    this._deps = {
      metricsCollector: null,
      profileController: null,
      logManager: null
    };

    // Son event verilerini yakala (rapor aninda kullanmak icin)
    this._lastRecordingData = null;
    this._lastLoopbackStats = null;
    this._lastReport = null;
    this._lastDeliveredSampleRate = null;

    // Event listener referanslari
    this._onRecordingCompleted = (data) => this._handleRecordingCompleted(data);
    this._onTestRecordingStopped = () => this._handleTestRecordingStopped();
    this._onTestCompleted = () => this._handleTestCompleted();
    this._onLoopbackStats = (stats) => { this._lastLoopbackStats = stats; };
    this._lastCapabilities = null;
    this._onStreamStarted = (stream) => {
      const track = stream?.getAudioTracks?.()?.[0];
      this._lastDeliveredSampleRate = track?.getSettings?.()?.sampleRate ?? null;
      // Device capabilities (EC/NS/AGC donanim destegi)
      const caps = track?.getCapabilities?.() ?? {};
      this._lastCapabilities = {
        sampleRateRange: caps.sampleRate ?? null,
        channelCountRange: caps.channelCount ?? null,
        ecSupported: caps.echoCancellation ?? null,
        nsSupported: caps.noiseSuppression ?? null,
        agcSupported: caps.autoGainControl ?? null
      };
    };

    eventBus.on(EVENTS.RECORDING_COMPLETED, this._onRecordingCompleted);
    eventBus.on(EVENTS.TEST_RECORDING_STOPPED, this._onTestRecordingStopped);
    eventBus.on(EVENTS.TEST_COMPLETED, this._onTestCompleted);
    eventBus.on(EVENTS.LOOPBACK_STATS, this._onLoopbackStats);
    eventBus.on(EVENTS.STREAM_STARTED, this._onStreamStarted);
  }

  /**
   * Bagimliliklari set et (app.js'den cagirilir)
   */
  init(deps) {
    Object.assign(this._deps, deps);
  }

  /**
   * Son olusturulan raporu dondur
   */
  getLastReport() {
    return this._lastReport;
  }

  /**
   * Raporu JSON olarak indir
   */
  exportReport(report = null) {
    const data = report || this._lastReport;
    if (!data) {
      log.warning('No diagnostic report generated yet');
      return null;
    }

    const filename = `mic-probe-diagnostic-${data.sessionId || 'unknown'}.json`;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    log.system('Diagnostic report exported', { filename });
    return data;
  }

  destroy() {
    eventBus.off(EVENTS.RECORDING_COMPLETED, this._onRecordingCompleted);
    eventBus.off(EVENTS.TEST_RECORDING_STOPPED, this._onTestRecordingStopped);
    eventBus.off(EVENTS.TEST_COMPLETED, this._onTestCompleted);
    eventBus.off(EVENTS.LOOPBACK_STATS, this._onLoopbackStats);
    eventBus.off(EVENTS.STREAM_STARTED, this._onStreamStarted);
  }

  // === PRIVATE: Event Handlers ===

  _handleRecordingCompleted(data) {
    this._lastRecordingData = data;
    // Kisa gecikme: MetricsCollector.stop() RECORDING_COMPLETED'dan once
    // calisabilir, setTimeout ile rapor sira garantisi
    setTimeout(() => this._buildAndEmit(), 0);
  }

  _handleTestRecordingStopped() {
    // Test kaydi bitti - playback basarisiz olsa bile rapor olustur
    // 100ms: MetricsCollector.stop() async olabilir, 0ms sira garantisi yeterli olmayabilir
    setTimeout(() => this._buildAndEmit(), 100);
  }

  _handleTestCompleted() {
    // Test tamamlandi (playback da bitti) - rapor zaten olusturulmussa tekrar olusturma
    if (!this._lastReport) {
      setTimeout(() => this._buildAndEmit(), 0);
    }
  }

  _buildAndEmit() {
    const report = this.build();
    if (report) {
      this._lastReport = report;
      eventBus.emit(EVENTS.DIAGNOSTIC_REPORT_READY, report);
      log.system('Diagnostic report ready', {
        score: report.audioMetrics?.snr?.estimatedDb,
        frames: report.audioMetrics?.sampleCount
      });
      if (IS_DEV) console.log('%c[DiagnosticReport]', 'color: #22c55e; font-weight: bold', report);
    }
  }

  // === PUBLIC: Build ===

  build() {
    const { metricsCollector, profileController, logManager } = this._deps;

    // Metrik sonuclari al (stop zaten cagirilmis, lastResults saklanmis)
    const audioMetrics = metricsCollector?.getResults?.() || null;

    return {
      version: '1.0',
      generatedAt: new Date().toISOString(),
      sessionId: logManager?.sessionId || null,

      environment: this._buildEnvironment(),
      device: this._buildDevice(),
      profile: this._buildProfile(profileController),
      recording: this._buildRecording(),
      loopback: this._buildLoopback(),
      audioMetrics: audioMetrics,
      sanityCheck: this._buildSanityCheck(logManager),
      logs: this._buildLogSummary(logManager)
    };
  }

  // === PRIVATE: Section Builders ===

  _buildEnvironment() {
    let audioWorkletSupported = false;
    try {
      audioWorkletSupported = typeof AudioWorkletNode !== 'undefined';
    } catch { /* */ }

    return {
      userAgent: navigator.userAgent,
      platform: navigator.platform || null,
      language: navigator.language,
      audioContextSupported: !!(window.AudioContext || window.webkitAudioContext),
      mediaDevicesSupported: !!navigator.mediaDevices?.getUserMedia,
      rtcPeerConnectionSupported: !!window.RTCPeerConnection,
      audioWorkletSupported
    };
  }

  _buildDevice() {
    // DeviceInfo DOM elementlerinden oku (lightweight, DI gerektirmez)
    const micNameEl = document.getElementById('infoMicName');
    const channelsEl = document.getElementById('infoChannels');

    return {
      micName: micNameEl?.title || micNameEl?.textContent || null,
      channelCount: channelsEl?.textContent === 'Stereo' ? 2
        : channelsEl?.textContent === 'Mono' ? 1 : null,
      sampleRate: this._lastDeliveredSampleRate ?? null,
      capabilities: this._lastCapabilities
    };
  }

  _buildProfile(profileController) {
    if (!profileController) return null;

    const profile = profileController.getCurrentProfile?.();
    const profileId = profileController.getCurrentProfileId?.();
    if (!profile) return { id: profileId };

    const v = profile.values || {};
    return {
      id: profileId,
      label: profile.label || null,
      category: profile.category || null,
      constraints: {
        echoCancellation: v.ec ?? null,
        noiseSuppression: v.ns ?? null,
        autoGainControl: v.agc ?? null,
        sampleRate: v.sampleRate ?? null,
        channelCount: v.channelCount ?? null
      },
      pipeline: v.pipeline || null,
      encoder: v.encoder || null,
      bitrate: v.loopback ? (v.bitrate || null) : (v.mediaBitrate || null),
      loopback: v.loopback ?? false,
      detection: profile.detection || null
    };
  }

  _buildRecording() {
    const d = this._lastRecordingData;
    if (!d) return null;

    return {
      durationMs: d.durationMs || null,
      blobSize: d.blob?.size || null,
      mimeType: d.mimeType || null,
      pipeline: d.pipeline || null,
      encoder: d.encoder || null,
      requestedBitrate: d.requestedBitrate || null,
      actualBitrate: d.actualBitrate || null,
      bitrateDeviation: (d.requestedBitrate && d.actualBitrate && d.requestedBitrate > 0)
        ? +((d.actualBitrate - d.requestedBitrate) / d.requestedBitrate).toFixed(3)
        : null
    };
  }

  _buildLoopback() {
    const s = this._lastLoopbackStats;
    if (!s) return null;

    const requested = parseFloat(s.requestedKbps) || 0;
    const actual = parseFloat(s.actualKbps) || 0;

    return {
      requestedBitrate: s.requestedBitrate || null,
      actualBitrate: s.actualBitrate || null,
      requestedKbps: requested || null,
      actualKbps: actual || null,
      bitrateDeviation: requested > 0 ? +((actual - requested) / requested).toFixed(3) : null,
      rttMs: s.rttMs ?? null,
      jitterMs: s.jitterMs ?? null,
      packetLossRate: s.packetLossRate ?? null,
      isDtxActive: s.isDtxActive ?? null
    };
  }

  _buildSanityCheck(logManager) {
    if (!logManager?.getSanityReport) return null;
    try {
      return logManager.getSanityReport();
    } catch {
      return null;
    }
  }

  _buildLogSummary(logManager) {
    if (!logManager) return null;

    const stats = logManager.getStats?.() || {};
    const errors = logManager.getByCategory?.('error') || [];
    const warnings = logManager.getByCategory?.('warning') || [];

    return {
      errorCount: stats.error || 0,
      warningCount: stats.warning || 0,
      totalCount: stats.total || 0,
      errors: errors.map(e => ({ message: e.message, details: e.details, timestamp: e.timestamp })),
      warnings: warnings.map(w => ({ message: w.message, details: w.details, timestamp: w.timestamp }))
    };
  }
}

// Singleton
const diagnosticReportBuilder = new DiagnosticReportBuilder();
export default diagnosticReportBuilder;
