/**
 * ReportPanelUI - Rapor popup yonetimi
 *
 * DIAGNOSTIC_REPORT_READY event'ini dinler; yeni kaydin kisa sonucunu Player'in
 * yaninda gosterir. Ayrintili popup kullanici eylemiyle acilir.
 *
 * Free: Kisa sonuc ve acilabilir olcum kapsami
 * Premium: Ekranda talimatlar, bulgular ve metrikler; PDF istege bagli
 */
import eventBus from '../modules/EventBus.js';
import { EVENTS } from '../modules/constants.js';
import premiumAccess from '../modules/PremiumAccess.js';
import accountAccess from '../modules/AccountAccess.js';
import checkoutStateSnapshot from '../modules/CheckoutStateSnapshot.js';
import profileController from '../controllers/ProfileController.js';
import reportEvaluator from '../modules/ReportEvaluator.js';
import { formatMeasurementValue, formatReportScope } from '../modules/MeasurementValue.js';
import { describeTroubleshootingContext } from '../modules/TroubleshootingContext.js';
import { log } from '../modules/utils.js';
import { createOverlayController } from './OverlayController.js';
import { ReportAssessmentUI } from './ReportAssessmentUI.js';
import {
  reportPanelEl,
  reportPopupCloseEl,
  reportDownloadBtnEl,
  reportScoreBadgeEl,
  reportOverallEl,
  reportFindingsEl,
  reportTroubleshootingContextEl,
  reportMetricsGridEl,
  reportRecommendationsEl,
  reportDetailedEl,
  reportDetailedWrapperEl,
  premiumOverlayEl,
  premiumCtaEl,
  premiumStatusEl,
  showReportBtnEl
} from './UIElements.js';

class ReportPanelUI {
  constructor() {
    // DOM referanslari (UIElements merkezi registry'den)
    this.panelEl = reportPanelEl;
    this.closeBtn = reportPopupCloseEl;
    this.scoreBadgeEl = reportScoreBadgeEl;
    this.overallEl = reportOverallEl;
    this.findingsEl = reportFindingsEl;
    this.troubleshootingContextEl = reportTroubleshootingContextEl;
    this.metricsGridEl = reportMetricsGridEl;
    this.recommendationsEl = reportRecommendationsEl;
    this.detailedEl = reportDetailedEl;
    this.wrapperEl = reportDetailedWrapperEl;
    this.premiumOverlayEl = premiumOverlayEl;
    this.premiumCtaEl = premiumCtaEl;
    this.premiumStatusEl = premiumStatusEl;
    this.showReportBtn = showReportBtnEl;
    this.downloadBtn = reportDownloadBtnEl;
    this.currentReport = null;
    this._resetViewOnOpen = false;
    // Basarili premium fetch sonucu (PDF'e eklemek icin); rapor degisince sifirlanir
    this._lastDetailed = null;
    this._detailedReport = null;
    this._premiumRequestId = 0;
    this._pendingPremiumReport = null;
    this._isDownloadingPdf = false;
    this.assessmentPanel = new ReportAssessmentUI({ root: document.getElementById('reportReview'),
      createElement: (...args) => this._createElement(...args),
      onSummary: summary => this._applySummary(summary),
      onSaved: () => {
        this._clearPremiumDetails(); this._renderPremiumDetails();
        this.workflow?.onReportSaved?.();
      },
      isSaved: runId => this.workflow?.isReportSaved?.(runId),
      waitForAccess: report => this.workflow?.waitForReportAccess?.(report) });

    // Rapor butonu (tekrar acma)
    this.showReportBtn?.addEventListener('click', () => {
      if (this.workflow?.getIsBusy?.() || !this.inlineReport) return;
      if (this.currentReport !== this.inlineReport) this._renderReport(this.inlineReport);
      this.open();
    });
    this.resultCard = document.getElementById('resultCard');
    this.inlineResultEl = document.getElementById('inlineResult');
    this.inlineTitleEl = document.getElementById('inlineResultTitle');
    this.inlineSummaryEl = document.getElementById('inlineResultSummary');
    this.retestBtn = document.getElementById('retestBtn');
    this.reportSetupBtn = document.getElementById('reportSetupBtn');
    this.reportRetestBtn = document.getElementById('reportRetestBtn');
    this.inlineReport = null;
    this.retestBtn?.addEventListener('click', () => {
      if (!this.workflow?.getIsBusy?.() && this._canRetest(this.inlineReport)) this.workflow?.onRetest?.(this.inlineReport);
    });
    this.reportRetestBtn?.addEventListener('click', () => {
      if (!this.workflow?.getIsBusy?.() && this._canRetest(this.currentReport)) this.workflow?.onRetest?.(this.currentReport);
    });
    this.reportSetupBtn?.addEventListener('click', () => {
      if (!this.workflow?.getIsBusy?.()) this.workflow?.onSetup?.();
    });
    this._workflowSubscriptions = [
      eventBus.on(EVENTS.PLAYER_RESET, () => this._clearInlineResult()),
      eventBus.on(EVENTS.UI_STATE_CHANGED, () => this.syncWorkflowActions())
    ];

    // Native <dialog>: ESC, focus trap ve arka plan inert tarayicidan; stack/odak geri donusu controller'dan
    this.overlay = createOverlayController(this.panelEl, {
      adapter: 'dialog',
      closeEls: [this.closeBtn],
      triggerEl: this.showReportBtn,
      initialFocus: () => this.closeBtn,
      onClose: () => { this._checkoutRevision = (this._checkoutRevision || 0) + 1; }
    });

    this._onPremiumClick = () => this._startPremiumCheckout();
    this.premiumCtaEl?.addEventListener('click', this._onPremiumClick);

    this._onDownloadClick = () => this._downloadPdf();
    this.downloadBtn?.addEventListener('click', this._onDownloadClick);

    this._unsubscribePremium = premiumAccess.subscribe(state => this._onPremiumState(state));
    premiumAccess.bootstrap().then(() => this._syncPremiumState());

    // Event dinleyiciler
    this._onReportReady = (report) => this._renderReport(report);
    eventBus.on(EVENTS.DIAGNOSTIC_REPORT_READY, this._onReportReady);
  }

  // === PUBLIC ===

  open() {
    if (this.overlay?.isOpen()) return;
    this.syncWorkflowActions();
    this.overlay?.open({ opener: this.showReportBtn });
    this._resetReportView();
    if (this.currentReport && premiumAccess.isUnlocked() && !this._lastDetailed) this._renderPremiumDetails();
  }

  close() {
    this.overlay?.close();
  }

  isOpen() {
    return !!this.overlay?.isOpen();
  }

  clearReport() {
    this.close();
    this.currentReport = null;
    this.assessmentPanel?.setReport(null, false);
    this._clearPremiumDetails();
    this.scoreBadgeEl?.replaceChildren();
    this.overallEl?.replaceChildren();
    this.findingsEl?.replaceChildren();
    this.troubleshootingContextEl?.replaceChildren();
    if (this.showReportBtn) this.showReportBtn.hidden = true;
    this._clearInlineResult();
  }

  setWorkflowActions(workflow) {
    this.workflow = workflow;
    this.syncWorkflowActions();
  }

  acceptSavedEvaluation(runId, evaluation) {
    if (!evaluation || this.currentReport?.run?.id !== runId || !premiumAccess.isUnlocked()
      || this.currentReport.savedEvaluation?.evaluatedAt === evaluation.evaluatedAt) return;
    this.currentReport.savedEvaluation = structuredClone(evaluation);
    this._applySummary(evaluation.public);
    this._clearPremiumDetails();
    this._renderPremiumDetails();
  }

  _canRetest(report) {
    // History can open a different report without replacing the loaded sample.
    return !!report && report === this.inlineReport && !!this.workflow?.canRetest?.(report);
  }

  syncWorkflowActions() {
    const busy = !!this.workflow?.getIsBusy?.();
    if (busy) this._checkoutRevision = (this._checkoutRevision || 0) + 1;
    const report = this.inlineReport;
    if (this.showReportBtn) this.showReportBtn.disabled = busy;
    if (this.retestBtn) {
      this.retestBtn.hidden = !this._canRetest(report);
      this.retestBtn.disabled = busy;
    }
    const canRetestCurrent = this._canRetest(this.currentReport);
    if (this.reportRetestBtn) {
      this.reportRetestBtn.hidden = !canRetestCurrent;
      this.reportRetestBtn.disabled = busy;
    }
    if (this.reportSetupBtn) {
      this.reportSetupBtn.textContent = canRetestCurrent ? 'Adjust test settings' : 'Back to test';
      this.reportSetupBtn.disabled = busy;
    }
    this.assessmentPanel?.render();
  }

  _clearInlineResult() {
    this.inlineReport = null;
    if (this.inlineResultEl) this.inlineResultEl.hidden = true;
    if (this.showReportBtn) this.showReportBtn.hidden = true;
    this.syncWorkflowActions();
  }

  destroy() {
    this.assessmentPanel?.setReport(null, false);
    this._premiumRequestId++;
    eventBus.off(EVENTS.DIAGNOSTIC_REPORT_READY, this._onReportReady);
    this.premiumCtaEl?.removeEventListener('click', this._onPremiumClick);
    this.downloadBtn?.removeEventListener('click', this._onDownloadClick);
    this._unsubscribePremium?.();
    this._workflowSubscriptions.forEach(unsubscribe => unsubscribe());
    this.overlay?.destroy();
  }

  // === PRIVATE: Helpers ===

  _buildStars(count) {
    if (!Number.isFinite(count)) return '';
    return '★'.repeat(count) + '☆'.repeat(5 - count);
  }

  _createElement(tagName, className = '', text = null) {
    const el = document.createElement(tagName);
    if (className) el.className = className;
    if (text !== null && text !== undefined) el.textContent = String(text);
    return el;
  }

  _createIconTextItem(className, icon, text) {
    const item = this._createElement('div', className);
    item.append(
      this._createElement('span', className.startsWith('rec-item') ? 'rec-icon' : 'finding-icon', icon),
      this._createElement('span', '', text)
    );
    return item;
  }

  async _startPremiumCheckout() {
    if (!this.premiumCtaEl || this.premiumCtaEl.disabled || this._hasInsufficientAudio() || this.workflow?.getIsBusy?.()) return;
    if (premiumAccess.isUnlocked()) {
      this.premiumCtaEl.disabled = true;
      this._setPremiumStatus('Loading your instructions…');
      try { await this._renderPremiumDetails(); }
      finally { this.premiumCtaEl.disabled = false; }
      return;
    }
    const purchase = premiumAccess.getState();
    if (purchase.pending || purchase.connectionError) {
      this.premiumCtaEl.disabled = true;
      this._setPremiumStatus('Checking your existing purchase…');
      try { await premiumAccess.retryPurchaseVerification(); }
      finally { this.premiumCtaEl.disabled = false; this._syncPremiumState(); }
      return;
    }
    if (purchase.purchaseLinked) { this.workflow?.onManagePurchase?.(); return; }

    const report = this.currentReport;
    const owner = accountAccess.getState().user?.id;
    const revision = this._checkoutRevision || 0;
    const isCurrent = () => this.isOpen() && this.currentReport === report
      && accountAccess.getState().user?.id === owner && (this._checkoutRevision || 0) === revision
      && !this.workflow?.getIsBusy?.();
    this.premiumCtaEl.disabled = true;
    this.premiumCtaEl.textContent = 'Opening checkout...';
    this._setPremiumStatus('Redirecting to secure checkout.');

    // Checkout ayni sekmede tam navigasyon - donuste restore icin snapshot al
    checkoutStateSnapshot.save({
      report: this.currentReport,
      ownerId: accountAccess.getState().user?.id || null,
      profileId: profileController.getCurrentProfileId()
    });

    try {
      await premiumAccess.startCheckout({ isCurrent: () => isCurrent() && !premiumAccess.getState().purchaseLinked });
    } catch (err) {
      if (!isCurrent()) return;
      this._setPremiumStatus(err.message === 'account_sign_in_required'
        ? 'Sign in to keep your lifetime purchase with your account.'
        : err.message === 'already_premium' ? 'Premium is already active. No new purchase is needed.'
        : err.message === 'purchase_verification_pending' ? 'Your purchase is waiting for verification. Retry purchase verification from Account.'
        : err.message === 'public_checkout_required' ? 'Open the public MicProbe site to purchase. Your test is preserved here.'
          : 'Checkout could not be opened. Please try again.');
      log.warning('Freemius checkout could not start', { error: err.message });
    } finally {
      this.premiumCtaEl.disabled = false;
      // Refresh the label without replacing a specific checkout error.
      const message = this.premiumStatusEl?.textContent || '';
      this._syncPremiumState();
      if (isCurrent() && message) this._setPremiumStatus(message);
    }
  }

  _onPremiumState(state) {
    const ownerId = state.userId || null;
    if (this._premiumOwnerId && this._premiumOwnerId !== ownerId) this.clearReport();
    this._premiumOwnerId = ownerId;
    this._syncPremiumState(state);
  }

  _syncPremiumState(state = premiumAccess.getState()) {
    this.assessmentPanel?.setReport(this.currentReport, premiumAccess.isUnlocked());
    const insufficient = this._hasInsufficientAudio();
    if (this.wrapperEl) this.wrapperEl.hidden = insufficient;
    if (insufficient) {
      this._clearPremiumDetails();
      return;
    }
    const pending = !!state.pending;
    const inactive = state.purchaseLinked && !state.unlocked;
    this._setPremiumPrompt(
      pending ? 'Purchase verification pending' : state.connectionError ? 'Connection unavailable'
        : inactive ? 'Premium access inactive' : 'Detailed measurements and PDF export',
      pending ? 'We could not confirm purchase access yet. You do not need to buy again.'
        : state.connectionError ? 'Reconnect to check your account and purchase access.'
        : inactive ? 'A purchase is linked to your account. Review its status before making another payment.'
        : 'Premium includes the detailed findings for this recording and optional PDF downloads. A recording does not guarantee a diagnosis.',
      pending ? 'Retry purchase verification' : state.connectionError ? 'Retry account connection'
        : inactive ? 'Review purchase' : 'Get Lifetime Premium'
    );
    if (premiumAccess.isUnlocked()) {
      if (this.premiumOverlayEl) this.premiumOverlayEl.hidden = true;
      this._setPremiumStatus('');
      this._renderPremiumDetails();
      return;
    }

    this._clearPremiumDetails();
    if (this.premiumOverlayEl) this.premiumOverlayEl.hidden = false;
    this._setPremiumStatus(pending ? 'We could not confirm purchase access yet. Retry when connected; your report is preserved.' : state.lastError || '');
  }

  _freeResult(report = this.currentReport) {
    const calculated = reportEvaluator.evaluateFree(report, this._platformSummary);
    const accepted = report === this.currentReport ? this._acceptedSummary : report?.savedEvaluation?.public;
    return accepted ? { ...calculated, ...accepted, findings: this._lastDetailed?.findings || calculated.findings } : calculated;
  }

  _applySummary(summary) {
    if (!this.currentReport || !summary) return;
    this._acceptedSummary = summary;
    this._platformSummary = summary.platform;
    this._renderScoreBadge(summary.overall);
    this._renderOverall(summary.overall, summary.summary, summary.scope, summary.assessment, summary.scopeSummary);
    if (this.inlineReport?.run?.id === this.currentReport.run?.id) {
      this.inlineTitleEl.textContent = summary.overall.label;
      this.inlineSummaryEl.textContent = [summary.summary, summary.scopeSummary].filter(Boolean).join(' ');
    }
  }

  _setPremiumStatus(message) {
    if (!this.premiumStatusEl) return;
    this.premiumStatusEl.textContent = message;
    this.premiumStatusEl.hidden = !message;
  }

  _setPremiumPrompt(title, description, action) {
    const copy = this.premiumOverlayEl?.querySelectorAll?.('.premium-text');
    if (copy?.[0]) copy[0].textContent = title;
    if (copy?.[1]) copy[1].textContent = description;
    if (this.premiumCtaEl) this.premiumCtaEl.textContent = action;
  }

  // === PRIVATE: Render ===

  _hasInsufficientAudio() {
    // Reuse the evaluator's completeness decision; no parallel audio thresholds.
    return !!this.currentReport && this._freeResult().assessment?.status === 'insufficient';
  }

  _renderReport(report) {
    if (!report) return;
    const ownerId = report.run?.accountOwnerId;
    if (ownerId && ownerId !== accountAccess.getState().user?.id) return;
    // A different report starts at its result; same-report async updates keep the reader's place.
    if (!this.currentReport || this.currentReport.run?.id !== report.run?.id
        || this.currentReport.run?.accountOwnerId !== ownerId) {
      this._resetViewOnOpen = true;
    }
    // A report owns its snapshot even if the caller later reuses its objects.
    this.currentReport = structuredClone(report);
    this._acceptedSummary = report.savedEvaluation?.public || null;
    this._platformSummary = this._acceptedSummary?.platform || null;
    this.panelEl?.classList?.toggle('report-popup--guidance', report.run?.type === 'troubleshooting');
    this._clearPremiumDetails();

    const free = this._freeResult();

    // Score badge
    this._renderScoreBadge(free.overall);

    // Overall skor
    this._renderOverall(free.overall, free.summary, free.scope, free.assessment, free.scopeSummary);

    this._syncPremiumState();

    // Only the report belonging to the loaded audio may update the inline result.
    // Saved reports and checkout restores open explicitly at their entry points.
    if (this.resultCard?.dataset.runId === report.run?.id) {
      const isNewResult = this.inlineReport?.run?.id !== report.run.id;
      this.inlineReport = this.currentReport;
      this.inlineTitleEl.textContent = free.overall.label;
      this.inlineSummaryEl.textContent = [free.summary, free.scopeSummary].filter(Boolean).join(' ');
      this.inlineResultEl.hidden = false;
      if (this.showReportBtn) this.showReportBtn.hidden = false;
      if (isNewResult && !document.querySelector('dialog[open]')) {
        this.resultCard.scrollIntoView({ block: 'start' });
      }
    }
    this.syncWorkflowActions();

    this._resetReportView();
    log.ui('Report popup rendered', { score: free.overall.score, findingCount: free.findings.length });
  }

  _resetReportView() {
    // A hidden dialog has no layout; reset only after it opens, or after replacing an open report.
    if (!this._resetViewOnOpen || !this.isOpen()) return;
    const body = this.panelEl?.querySelector('.report-popup-body');
    body?.querySelectorAll('details[open]').forEach(details => { details.open = false; });
    if (body) { body.scrollTop = 0; body.scrollLeft = 0; }
    this._resetViewOnOpen = false;
  }

  async _renderPremiumDetails() {
    if (!this.currentReport || this._hasInsufficientAudio()) {
      this._clearPremiumDetails();
      return;
    }

    const report = this.currentReport;
    if (this._pendingPremiumReport === report || (this._detailedReport === report && this._lastDetailed)) return;
    this._pendingPremiumReport = report;
    const requestId = ++this._premiumRequestId;
    this._setDetailedState('loading');
    try {
      const detailed = report.savedEvaluation?.detailed || await premiumAccess.fetchDetailedReport(report);
      if (requestId !== this._premiumRequestId || report !== this.currentReport || !premiumAccess.isUnlocked()) return;
      this._setDetailedState('ready');
      this._lastDetailed = detailed;
      this._applySummary(detailed.summary || { ...reportEvaluator.evaluateFree(report, detailed.platform), platform: detailed.platform });
      this._detailedReport = report;
      if (this.detailedEl) this.detailedEl.hidden = false;
      if (this.premiumOverlayEl) this.premiumOverlayEl.hidden = true;
      this._setPremiumStatus('');
      this._renderFindings(this._freeResult());
      this._renderTroubleshootingContext();
      this._renderMetrics(detailed.metrics);
      this._renderRecommendations(detailed.recommendations);
      this._syncPdfDownload();
    } catch (err) {
      if (requestId !== this._premiumRequestId || report !== this.currentReport || !premiumAccess.isUnlocked()) return;
      this._setDetailedState('error');
      this._clearPremiumDetails();
      if (this.premiumOverlayEl) this.premiumOverlayEl.hidden = false;
      this._setPremiumPrompt('Your Premium access is active',
        'Instructions could not be loaded. Retry here; no new purchase is needed.', 'Retry instructions');
      this._setPremiumStatus('');
      log.warning('Premium details could not be loaded', { error: err.message });
    } finally {
      if (requestId === this._premiumRequestId) this._pendingPremiumReport = null;
    }
  }

  /**
   * Premium ayrinti alaninin yukleme durumu: loading | ready | error (CSS: [data-state], aria-busy).
   * Account paneliyle ayni durum sozlesmesi (loading/empty/error).
   */
  _setDetailedState(state) {
    const wrapper = this.wrapperEl;
    if (!wrapper?.setAttribute) return;
    wrapper.setAttribute('data-state', state);
    wrapper.setAttribute('aria-busy', state === 'loading' ? 'true' : 'false');
  }

  _clearPremiumDetails() {
    this._premiumRequestId++;
    this._lastDetailed = null;
    this._detailedReport = null;
    this._pendingPremiumReport = null;
    if (this.detailedEl) this.detailedEl.hidden = true;
    this.findingsEl?.replaceChildren();
    this.troubleshootingContextEl?.replaceChildren();
    this.metricsGridEl?.replaceChildren();
    this.recommendationsEl?.replaceChildren();
    if (this.wrapperEl?.getAttribute?.('data-state') !== 'error') this._setDetailedState('idle');
    this._syncPdfDownload();
  }

  _canDownloadPdf() {
    return !!this.currentReport && premiumAccess.isUnlocked()
      && this._detailedReport === this.currentReport && !!this._lastDetailed;
  }

  _syncPdfDownload() {
    if (!this.downloadBtn) return;
    const available = this._canDownloadPdf();
    this.downloadBtn.hidden = !available;
    this.downloadBtn.disabled = !available || this._isDownloadingPdf;
  }

  /**
   * Raporu PDF olarak indir (jsPDF lazy-load - butona basilana kadar yuklenmez).
   * Yalniz aktif Premium ve ayni rapora ait yuklenmis detaylar PDF'e aktarilir.
   */
  async _downloadPdf() {
    if (!this.downloadBtn || this._isDownloadingPdf || !this._canDownloadPdf()) return;

    this._isDownloadingPdf = true;
    this._syncPdfDownload();
    const report = this.currentReport;
    const free = this._freeResult();
    const detailed = this._lastDetailed;
    const ownerId = premiumAccess.getState().userId;
    // Keep the clicked report, but recheck its owner's access across both lazy imports.
    const canDownload = () => premiumAccess.isUnlocked() && premiumAccess.getState().userId === ownerId;
    try {
      const { downloadReportPdf } = await import('../modules/ReportPdfExporter.js');
      if (!canDownload()) return;
      const downloaded = await downloadReportPdf({ report, free, detailed, canDownload });
      if (downloaded) log.ui('Report PDF downloaded', { sessionId: report.sessionId, runId: report.run?.id });
    } catch (err) {
      log.error('Report PDF download failed', { error: err.message });
      eventBus.emit(EVENTS.UI_MESSAGE, {
        message: 'PDF could not be generated. Please try again.',
        tone: 'error'
      });
    } finally {
      this._isDownloadingPdf = false;
      this._syncPdfDownload();
    }
  }

  _renderScoreBadge(overall) {
    if (!this.scoreBadgeEl) return;
    const stars = this._buildStars(overall.stars);
    this.scoreBadgeEl.textContent = `${stars} ${overall.label}`.trim();
    this.scoreBadgeEl.dataset.color = overall.color;
  }

  _renderOverall(overall, summary, scope, assessment, scopeSummary) {
    scope = formatReportScope(scope);
    if (!this.overallEl) return;

    const emoji = overall.score === 'good' ? '\u2713' : overall.score === 'fair' ? '!'
      : overall.score === 'unknown' || overall.score === 'limited' ? 'i' : '\u2715';
    const stars = this._buildStars(overall.stars);

    const indicator = this._createElement('div', 'report-overall-indicator', emoji);
    indicator.dataset.color = overall.color;

    const textWrap = this._createElement('div', 'report-overall-text');
    textWrap.append(
      this._createElement('div', 'report-overall-label', overall.label),
      this._createElement('div', 'report-overall-stars', stars)
    );

    textWrap.append(this._createElement('div', 'report-overall-summary', summary));
    if (scopeSummary) textWrap.append(this._createElement('p', 'report-overall-summary', scopeSummary));
    if (scope) {
      const disclosure = this._createElement('details', 'report-scope');
      disclosure.append(
        this._createElement('summary', '', assessment?.status === 'limited' ? 'Limited assessment · What was measured' : 'What was measured'),
        this._createElement('p', '', scope)
      );
      textWrap.append(disclosure);
    }
    this.overallEl.replaceChildren(indicator, textWrap);
  }

  _renderFindings(free) {
    if (!this.findingsEl) return;
    if (free.assessment?.status === 'not-measured') {
      this.findingsEl.replaceChildren();
      return;
    }
    const findings = free.findings;

    if (findings.length === 0) {
      this.findingsEl.replaceChildren(
        this._createIconTextItem(
          'finding-item',
          free.overall.score === 'good' ? '\u2713' : 'i',
          free.summary
        )
      );
      return;
    }

    const items = findings.map(f => {
      const severity = ['critical', 'warning'].includes(f.severity) ? f.severity : 'info';
      return this._createIconTextItem(
        `finding-item finding-item--${severity}`,
        severity === 'critical' ? '!' : severity === 'warning' ? '~' : 'i',
        severity === 'info' ? `Observation: ${f.message}` : f.message
      );
    });
    this.findingsEl.replaceChildren(...items);
  }

  _renderMetrics(metrics) {
    if (!this.metricsGridEl || !metrics) return;

    if (metrics.length === 0) {
      this.metricsGridEl.replaceChildren(
        this._createIconTextItem('finding-item', '→', 'No detailed metrics for this run.')
      );
      return;
    }

    const cards = metrics.map(m => {
      const val = m.value != null ? formatMeasurementValue(m.value) : '--';
      const card = this._createElement('div', 'metric-card');
      card.dataset.rating = m.rating || 'info';

      const valueEl = this._createElement('div', 'metric-card-value', val);
      valueEl.append(this._createElement('span', 'metric-card-unit', m.unit || ''));

      card.append(
        this._createElement('div', 'metric-card-label', m.label),
        valueEl
      );
      return card;
    });
    this.metricsGridEl.replaceChildren(...cards);
  }

  _renderTroubleshootingContext() {
    if (!this.troubleshootingContextEl) return;
    const context = this.currentReport?.troubleshooting;
    const rows = context && context.symptom !== 'unknown' ? describeTroubleshootingContext(context) : [];
    this.troubleshootingContextEl.replaceChildren();
    if (!rows.length) return;
    this.troubleshootingContextEl.append(
      this._createElement('strong', '', 'Your troubleshooting context — not a measurement'),
      ...rows.map(([label, value]) => this._createElement('div', '', `${label}: ${value}`))
    );
  }

  _renderRecommendations(recommendations) {
    if (!this.recommendationsEl) return;

    if (!recommendations || recommendations.length === 0) {
      this.recommendationsEl.replaceChildren(
        this._createIconTextItem('rec-item', '\u2192', 'No additional recommendations found.')
      );
      return;
    }

    const CATEGORY_LABELS = {
      troubleshooting: 'Steps for your system and app', setting: 'Settings', microphone: 'Microphone', system: 'System / Performance',
      environment: 'Environment', profile: 'Test scope', observation: 'Observations — no quality penalty'
    };
    const ORDER = ['troubleshooting', 'setting', 'microphone', 'system', 'environment', 'observation', 'profile'];

    // Kategoriye gore grupla
    const groups = {};
    for (const r of recommendations) {
      const cat = r.category || 'profile';
      (groups[cat] = groups[cat] || []).push(r);
    }
    const cats = Object.keys(groups).sort(
      (a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99)
    );

    const nodes = [];
    for (const cat of cats) {
      const title = this._createElement('div', `report-section-title rec-category-${cat}`, CATEGORY_LABELS[cat] || cat);
      nodes.push(title);

      for (const r of groups[cat]) {
        const item = this._createElement('div', 'rec-item rec-item--rich');
        const head = this._createElement('div', 'rec-head');
        head.append(this._createElement('span', 'rec-icon', '\u2192'));
        head.append(this._createElement('span', 'rec-action', r.action || r.reason || r.message || ''));
        item.append(head);
        if (r.action && (r.reason || r.message)) item.append(this._createElement('div', 'rec-reason', r.reason || r.message));
        if (r.evidence) item.append(this._createElement('div', 'rec-evidence', r.evidence));
        if (r.confidence) item.append(this._createElement('span', `rec-confidence rec-confidence--${r.confidence}`, `Confidence: ${r.confidence}`));
        if (Array.isArray(r.steps) && r.steps.length) {
          const steps = this._createElement('ol', 'rec-steps');
          steps.append(...r.steps.map(step => this._createElement('li', '', step)));
          item.append(steps);
        }
        if (r.expected) item.append(this._createElement('div', 'rec-outcome', `What to check: ${r.expected}`));
        if (r.next) item.append(this._createElement('div', 'rec-outcome', `If it continues: ${r.next}`));
        for (const source of r.sources || []) {
          let url;
          try { url = new URL(source.url); } catch { continue; }
          if (url.protocol !== 'https:' || url.username || url.password) continue;
          const line = this._createElement('div', 'rec-source');
          const link = this._createElement('a', '', source.label || 'Official guidance');
          link.href = url.href;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          line.append(link);
          item.append(line);
        }
        nodes.push(item);
      }
    }
    this.recommendationsEl.replaceChildren(...nodes);
  }
}

const reportPanelUI = new ReportPanelUI();
export default reportPanelUI;
