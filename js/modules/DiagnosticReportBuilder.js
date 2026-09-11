/**
 * DiagnosticReportBuilder - Yapilandirilmis diagnostik rapor olusturucu
 *
 * Test/kayit tamamlandiginda tum verileri birlestirip JSON rapor olusturur.
 * Free degerlendirmeyi ReportEvaluator, premium detaylari Node/Worker evaluator yapar.
 *
 * Veri kaynaklari:
 * - DeepAnalysisEngine (kayit dosyasindan kesintisiz PCM olcumleri)
 * - RunSnapshot (baslangicta secilen ve gercekte uygulanan ayarlar)
 * - LogManager (sanity report, log istatistikleri)
 * - RECORDING_COMPLETED event (kayit verisi)
 * - LOOPBACK_STATS event (WebRTC istatistikleri)
 * - RunSnapshot.environment (capture-time browser hints)
 */
import eventBus from './EventBus.js';
import { EVENTS, IS_DEV } from './constants.js';
import { log, downloadBlob } from './utils.js';
import { UNKNOWN_COMMUNICATION_CONTEXT } from './CommunicationContext.js';
import { UNKNOWN_TROUBLESHOOTING_CONTEXT } from './TroubleshootingContext.js';
import { UNKNOWN_ENVIRONMENT } from './EnvironmentContext.js';
import { getConstraintMismatches } from './CaptureContext.js';

class DiagnosticReportBuilder {
  constructor() {
    // Dependency injection ile set edilecek referanslar
    this._deps = {
      deepAnalysisEngine: null,
      systemProbeCollector: null,
      logManager: null
    };

    // Son event verilerini yakala (rapor aninda kullanmak icin)
    this._lastRecordingData = null;
    this._lastLoopbackStats = null;
    this._lastDeepAnalysis = null;
    this._lastReport = null;
    this._publishedRunId = null;
    this._activeRunType = null;
    this._testSampleReady = false;
    this._reportTimerId = null;
    this._pendingReportRunId = null;
    this._lastProfileId = null;

    // Event listener referanslari
    this._onRecordingStarted = (data) => this._beginRun('record', data);
    this._onTestRecordingStarted = (data) => this._beginRun('test', data);
    this._onProfileChanged = (data) => this._handleProfileChanged(data);
    this._onRecordingCompleted = (data) => this._handleRecordingCompleted(data);
    this._onTestRecordingStopped = (data) => this._handleTestRecordingStopped(data);
    this._onTestCompleted = (data) => this._handleTestCompleted(data);
    this._onTestCancelled = (data) => this._handleTestCancelled(data);
    this._onCaptureStopped = (data) => {
      if (!this._matchesRun(data)) return;
      this._captureClosed = true;
      this._systemSnapshot = this._deps.systemProbeCollector?.stop?.() || null;
    };
    this._onLoopbackStats = (stats) => {
      if (!this._captureClosed && this._matchesRun(stats)) this._lastLoopbackStats = structuredClone(stats);
    };
    this._onDeepAnalysisReady = (data) => {
      if (this._matchesRun(data)) this._lastDeepAnalysis = data;
    };

    eventBus.on(EVENTS.RECORDING_STARTED, this._onRecordingStarted);
    eventBus.on(EVENTS.TEST_RECORDING_STARTED, this._onTestRecordingStarted);
    eventBus.on(EVENTS.PROFILE_CHANGED, this._onProfileChanged);
    eventBus.on(EVENTS.RECORDING_COMPLETED, this._onRecordingCompleted);
    eventBus.on(EVENTS.RECORDING_CAPTURE_STOPPED, this._onCaptureStopped);
    eventBus.on(EVENTS.TEST_RECORDING_STOPPED, this._onTestRecordingStopped);
    eventBus.on(EVENTS.TEST_COMPLETED, this._onTestCompleted);
    eventBus.on(EVENTS.TEST_CANCELLED, this._onTestCancelled);
    eventBus.on(EVENTS.LOOPBACK_STATS, this._onLoopbackStats);
    eventBus.on(EVENTS.DEEP_ANALYSIS_READY, this._onDeepAnalysisReady);
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

  // Capture can already be idle while its saved file is still being analysed or published.
  isReportPending() {
    return !!this._pendingReportRunId && this._matchesRun({ runId: this._pendingReportRunId });
  }

  /**
   * Disaridan saglanan hazir bir raporu son rapor olarak kabul et (checkout donusu).
   * build() CAGRILMAZ; rapor onceki calismanin donmus ciktisidir. Emit, mevcut
   * DIAGNOSTIC_REPORT_READY akisini (ReportPanelUI render + showReportBtn) aynen tetikler.
   */
  restoreReport(report) {
    if (!report) return;
    this._lastReport = report;
    eventBus.emit(EVENTS.DIAGNOSTIC_REPORT_READY, report);
    log.system('Saved diagnostic report restored', { sessionId: report.sessionId || null, runId: report.run?.id || null });
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
    downloadBlob(blob, filename);

    log.system('Diagnostic report exported', { filename });
    return data;
  }

  destroy() {
    this._resetRunState();
    eventBus.off(EVENTS.RECORDING_STARTED, this._onRecordingStarted);
    eventBus.off(EVENTS.TEST_RECORDING_STARTED, this._onTestRecordingStarted);
    eventBus.off(EVENTS.PROFILE_CHANGED, this._onProfileChanged);
    eventBus.off(EVENTS.RECORDING_COMPLETED, this._onRecordingCompleted);
    eventBus.off(EVENTS.RECORDING_CAPTURE_STOPPED, this._onCaptureStopped);
    eventBus.off(EVENTS.TEST_RECORDING_STOPPED, this._onTestRecordingStopped);
    eventBus.off(EVENTS.TEST_COMPLETED, this._onTestCompleted);
    eventBus.off(EVENTS.TEST_CANCELLED, this._onTestCancelled);
    eventBus.off(EVENTS.LOOPBACK_STATS, this._onLoopbackStats);
    eventBus.off(EVENTS.DEEP_ANALYSIS_READY, this._onDeepAnalysisReady);
  }

  // === PRIVATE: Event Handlers ===

  _beginRun(type, data = {}) {
    this._captureClosed = false;
    this._deps.deepAnalysisEngine?.cancel?.(this._runSnapshot?.runId);
    this._clearReportTimer();
    this._pendingReportRunId = null;
    this._runSnapshot = data.runSnapshot || null;
    this._systemSnapshot = null;
    this._activeRunType = type;
    this._testSampleReady = false;
    this._lastRecordingData = null;
    this._lastLoopbackStats = null;
    this._lastDeepAnalysis = null;
    this._lastReport = null;
    this._publishedRunId = null;
  }

  _resetRunState() {
    this._captureClosed = true;
    this._deps.deepAnalysisEngine?.cancel?.(this._runSnapshot?.runId);
    this._runSnapshot = null;
    this._systemSnapshot = null;
    this._clearReportTimer();
    this._pendingReportRunId = null;
    this._activeRunType = null;
    this._testSampleReady = false;
    this._lastRecordingData = null;
    this._lastLoopbackStats = null;
    this._lastDeepAnalysis = null;
    this._lastReport = null;
    this._publishedRunId = null;
  }

  _handleProfileChanged(data = {}) {
    const nextProfileId = data.profile || null;
    if (!nextProfileId) return;

    if (this._lastProfileId && nextProfileId !== this._lastProfileId) {
      this._resetRunState();
    }

    this._lastProfileId = nextProfileId;
  }

  _matchesRun(data) {
    const id = data?.runId ?? data?.runSnapshot?.runId;
    return !!id && id === this._runSnapshot?.runId;
  }

  async _handleRecordingCompleted(data) {
    if (!this._matchesRun(data)) return;
    this._lastRecordingData = data;
    const runId = this._runSnapshot.runId;
    this._pendingReportRunId = runId;
    try {
      const result = await this._deps.deepAnalysisEngine?.analyze?.(data.blob, { source: 'record', runId, guidedSegments: data.guidedSegments });
      if (!this._matchesRun({ runId })) return;
      this._lastDeepAnalysis = result || { runId, status: 'unavailable' };
    } catch (error) {
      if (!this._matchesRun({ runId })) return;
      this._lastDeepAnalysis = { runId, status: 'failed', reason: error.message };
    }
    this._scheduleBuildAndEmit(0);
  }

  _handleTestRecordingStopped(data) {
    if (!this._matchesRun(data)) return;
    this._onCaptureStopped(data);
    // Analiz sonucu ve Player'a yuklenen dosya TEST_COMPLETED ile birlestirilir.
    this._testSampleReady = true;
    this._pendingReportRunId = this._runSnapshot.runId;
  }

  _handleTestCompleted(data) {
    if (!this._matchesRun(data)) return;
    if (data?.analysis) this._lastDeepAnalysis = data.analysis;
    if (data?.recording) this._lastRecordingData = { ...data.recording };
    if (this._testSampleReady && this._publishedRunId !== this._runSnapshot.runId) {
      this._scheduleBuildAndEmit(0);
    }
  }

  _handleTestCancelled(data) {
    if (this._matchesRun(data)) this._resetRunState();
  }

  _clearReportTimer() {
    if (this._reportTimerId) {
      clearTimeout(this._reportTimerId);
      this._reportTimerId = null;
    }
  }

  _scheduleBuildAndEmit(delayMs) {
    this._clearReportTimer();
    const runId = this._runSnapshot?.runId;
    this._pendingReportRunId = runId;
    this._reportTimerId = setTimeout(() => {
      this._reportTimerId = null;
      if (this._matchesRun({ runId })) this._buildAndEmit();
    }, delayMs);
  }

  _buildAndEmit() {
    const runId = this._runSnapshot?.runId;
    let report;
    try {
      report = this.build();
    } finally {
      // Listeners see the report as settled; a new run keeps its own pending marker.
      if (this._pendingReportRunId === runId) this._pendingReportRunId = null;
    }
    if (report) {
      // The displayed/restored report does not own completion of the active run.
      this._publishedRunId = runId;
      this._lastReport = report;
      eventBus.emit(EVENTS.DIAGNOSTIC_REPORT_READY, report);
      log.system('Diagnostic report ready', {
        runId: report.run.id,
        measurementStatus: report.audioMetrics?.status ?? 'unavailable',
        frames: report.audioMetrics?.sampleCount
      });
      if (IS_DEV) console.log('%c[DiagnosticReport]', 'color: #22c55e; font-weight: bold', report);
    }
  }

  // === PUBLIC: Build ===

  /**
   * A user-requested help report has its own identity and no measured sample.
   * Do not begin/reset a run here: an active capture and its pending analysis keep ownership.
   */
  createGuidanceReport(runSnapshot) {
    if (typeof runSnapshot?.runId !== 'string' || !runSnapshot.runId.trim()) {
      throw new TypeError('A new run snapshot is required for a troubleshooting report.');
    }
    return {
      version: '2.0',
      generatedAt: new Date().toISOString(),
      sessionId: this._deps.logManager?.sessionId || null,
      run: { id: runSnapshot.runId, accountOwnerId: runSnapshot.accountOwnerId || null, type: 'troubleshooting' },
      environment: this._buildEnvironment(runSnapshot),
      communicationContext: {
        ...(runSnapshot.communicationContext || UNKNOWN_COMMUNICATION_CONTEXT),
        usage: runSnapshot.troubleshooting?.usage || 'unknown'
      },
      troubleshooting: runSnapshot.troubleshooting || UNKNOWN_TROUBLESHOOTING_CONTEXT,
      device: null,
      profile: {
        id: null,
        label: 'Troubleshooting',
        category: null,
        approximation: false,
        scope: 'Guidance based on your description; no audio was captured or measured.'
      },
      recording: null,
      loopback: null,
      audioMetrics: null,
      deepAnalysis: null,
      system: null,
      sanityCheck: null,
      logs: null
    };
  }

  build() {
    const { logManager } = this._deps;

    // UI onizlemesi yerine ayni runId'ye ait kayit dosyasinin sonucunu kullan.
    const audioMetrics = this._lastDeepAnalysis?.audioMetrics || null;

    return {
      version: '2.0',
      generatedAt: new Date().toISOString(),
      sessionId: logManager?.sessionId || null,
      run: {
        id: this._runSnapshot?.runId || null,
        accountOwnerId: this._runSnapshot?.accountOwnerId || null,
        type: this._activeRunType,
        testSampleReady: this._activeRunType === 'test' ? this._testSampleReady : undefined
      },

      environment: this._buildEnvironment(),
      communicationContext: this._runSnapshot?.communicationContext || UNKNOWN_COMMUNICATION_CONTEXT,
      troubleshooting: this._runSnapshot?.troubleshooting || UNKNOWN_TROUBLESHOOTING_CONTEXT,
      device: this._buildDevice(),
      profile: this._buildProfile(),
      recording: this._buildRecording(),
      loopback: this._buildLoopback(),
      audioMetrics: audioMetrics,
      deepAnalysis: this._lastDeepAnalysis,   // Kayit dosyasinin cevrimdisi analizi ve PCM metrikleri; yoksa null
      captureContext: this._buildCaptureContext(audioMetrics),
      system: this._buildSystem(),
      sanityCheck: this._buildSanityCheck(logManager),
      logs: this._buildLogSummary(logManager)
    };
  }

  // === PRIVATE: Section Builders ===

  /**
   * Sistem/performans sinyalleri + korelasyon.
   * DURUSTLUK: yalnizca dolayli proxy; her cikti confidence + disclaimer tasir.
   */
  _buildSystem() {
    const sys = this._systemSnapshot;
    if (!sys) return null;
    return { ...sys, correlation: this._correlateSystem(sys) };
  }

  _correlateSystem(sys) {
    const findings = [{
      id: 'INCONCLUSIVE', confidence: 'unavailable',
      message: 'Browser scheduling and local transport observations do not identify the cause of an audio problem.'
    }];

    if (sys?.tabWasHidden) {
      findings.push({
        id: 'TAB_HIDDEN',
        confidence: 'low',
        message: 'The tab was backgrounded during the test; main-thread jitter measurements are unreliable.'
      });
    }

    return {
      method: 'observations-only',
      findings,
      disclaimer: 'Dolayli sinyallere dayanir; kesin nedensellik iddia etmez. Tarayici gercek CPU/RAM olcemez.'
    };
  }

  _buildEnvironment(snapshot = this._runSnapshot) {
    return snapshot?.environment || UNKNOWN_ENVIRONMENT;
  }

  _buildDevice() {
    return this._runSnapshot?.device || null;
  }

  _buildProfile() {
    const run = this._runSnapshot;
    if (!run) return null;
    const v = run.requestedSettings || {};
    const applied = run.appliedSettings || {};
    const keys = ['echoCancellation', 'noiseSuppression', 'autoGainControl', 'sampleRate', 'channelCount'];
    const constraints = Object.fromEntries(keys.map(key => [key, applied[key] ?? null]));
    // The device may ignore a requested value (e.g. 44.1 kHz on a 48 kHz-only interface,
    // mono on a stereo pair). Keep both and list every difference explicitly.
    const constraintMismatches = getConstraintMismatches({ requestedConstraints: v, appliedConstraints: constraints });
    return {
      id: run.profileId,
      label: run.profileLabel,
      referenceVersion: run.profileReferenceVersion ?? null,
      runtime: run.captureRuntime ?? null,
      category: run.category,
      constraints,
      appliedConstraints: constraints,
      requestedConstraints: v,
      constraintMismatches,
      pipeline: run.pipeline ?? v.pipeline ?? null,
      encoder: this._activeRunType === 'test' ? null : run.encoder ?? v.encoder ?? null,
      requestedEncoder: v.encoder ?? null,
      bitrate: v.bitrate ?? null,
      loopback: v.loopback ?? false,
      detection: run.detection || null,
      evidence: run.evidence || null,
      approximation: run.profileId !== 'raw',
      scope: run.profileId === 'raw' ? 'Uncompressed recording of the audio delivered by the browser; hardware and operating-system processing may still apply.'
        : 'Local browser processing preset; does not reproduce the named application or its network.'
    };
  }

  /**
   * What the browser knows and cannot know about the input path. The operating
   * system's input level, driver processing and audio enhancements are not exposed
   * to web apps; a pinned waveform ceiling in audioMetrics is the only indirect sign.
   */
  _buildCaptureContext(audioMetrics) {
    const run = this._runSnapshot;
    if (!run) return null;
    const applied = run.appliedSettings || {};
    return {
      deviceLabel: run.device?.micName ?? null,
      capabilities: run.device?.capabilities ?? null,
      channelLayout: audioMetrics?.channelLayout ?? null,
      osInputLevel: { status: 'unavailable', reason: 'not-exposed-to-web-apps' },
      osProcessing: { status: 'unavailable', reason: 'driver-and-enhancement-state-not-exposed-to-web-apps' },
      browserInputVolumeAdjustment: applied.autoGainControl === true
        ? { status: 'possible', reason: 'browser-agc-may-change-system-input-level' }
        : applied.autoGainControl === false
          ? { status: 'not-expected', reason: 'automatic-gain-control-off' }
          : { status: 'unavailable', reason: 'applied-automatic-gain-control-unknown' },
      pinnedCeiling: audioMetrics?.ceiling?.status === 'measured'
        ? { peakDb: audioMetrics.ceiling.peakDb, flatTopRate: audioMetrics.ceiling.flatTopRate,
          nearCeilingRate: audioMetrics.ceiling.nearCeilingRate } : null
    };
  }

  _buildRecording() {
    if (!['record', 'test'].includes(this._activeRunType)) return null;

    const d = this._lastRecordingData;
    if (!d) return null;
    const isCallSample = this._activeRunType === 'test';
    const requestedBitrate = isCallSample ? null : d.requestedBitrate ?? this._runSnapshot?.requestedSettings?.bitrate;

    return {
      durationMs: d.durationMs ?? null,
      blobSize: d.blob?.size ?? d.blobSize ?? null,
      mimeType: d.mimeType || null,
      mimeTypeSource: d.mimeTypeSource || null,
      pipeline: d.pipeline || null,
      encoder: d.encoder || null,
      requestedBitrate: requestedBitrate > 0 ? requestedBitrate : null,
      bitrateMode: isCallSample ? 'browser-default' : d.encoder === 'pcm-wav' ? 'uncompressed-pcm' : requestedBitrate === 0 ? 'encoder-default-vbr' : 'requested',
      encoderReportedBitrate: Number.isFinite(d.encoderReportedBitrate) && d.encoderReportedBitrate > 0 ? d.encoderReportedBitrate : null,
      actualBitrate: d.actualBitrate ?? null,
      bitrateDeviation: null,
      stopReason: d.stopReason || null,
      durationSource: d.durationSource || null,
      guidedSegments: d.guidedSegments || null,
      bitrateSource: d.bitrateSource || null,
      sampleCount: d.sampleCount ?? null,
      encoderPaddingFrames: d.encoderPaddingFrames ?? null,
      sampleSource: isCallSample ? 'saved-received-audio' : 'saved-recording'
    };
  }

  _buildLoopback() {
    if (this._activeRunType !== 'test') return null;

    const s = this._lastLoopbackStats || {};
    const requestedBitrate = s.requestedBitrate ?? this._runSnapshot?.requestedSettings?.bitrate ?? null;

    return {
      requestedCodec: 'audio/opus',
      requestedOpus: this._runSnapshot?.transport || null,
      senderCodec: s.senderCodec || null,
      receiverCodec: s.receiverCodec || null,
      requestedBitrate,
      bitrateMeaning: 'maximum-average-bitrate',
      actualBitrate: s.actualBitrate ?? null,
      requestedKbps: s.requestedKbps ?? (requestedBitrate > 0 ? requestedBitrate / 1000 : null),
      actualKbps: s.actualKbps ?? null,
      bitrateDeviation: null,
      rttMs: s.rttMs ?? null,
      jitterMs: s.jitterMs ?? null,
      packetLossRate: s.packetLossRate ?? null,
      isDtxActive: null,
      sampleSource: 'saved-received-audio',
      measurementBoundary: 'Received loopback audio saved through MediaRecorder; file measurements include this additional encoding.',
      receive: s.receive || null,
      timestamp: s.timestamp ?? null
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
      scope: 'browser-session',
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
