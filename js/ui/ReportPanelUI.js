/**
 * ReportPanelUI - Rapor popup yonetimi
 *
 * DIAGNOSTIC_REPORT_READY event'ini dinler, ReportEvaluator ile
 * degerlendirme yapar, sonuclari popup olarak gosterir.
 *
 * Free: Ozet skor + bulgular (herkese gorunur)
 * Premium: Metrikler + oneriler (blur/kilit)
 */
import eventBus from '../modules/EventBus.js';
import { EVENTS } from '../modules/constants.js';
import premiumAccess from '../modules/PremiumAccess.js';
import reportEvaluator from '../modules/ReportEvaluator.js';
import { log } from '../modules/utils.js';
import {
  reportPopupBackdropEl,
  reportPanelEl,
  reportPopupCloseEl,
  reportScoreBadgeEl,
  reportOverallEl,
  reportFindingsEl,
  reportMetricsGridEl,
  reportRecommendationsEl,
  reportDetailedEl,
  premiumOverlayEl,
  premiumCtaEl,
  premiumStatusEl,
  showReportBtnEl
} from './UIElements.js';

class ReportPanelUI {
  constructor() {
    // DOM referanslari (UIElements merkezi registry'den)
    this.backdropEl = reportPopupBackdropEl;
    this.panelEl = reportPanelEl;
    this.closeBtn = reportPopupCloseEl;
    this.scoreBadgeEl = reportScoreBadgeEl;
    this.overallEl = reportOverallEl;
    this.findingsEl = reportFindingsEl;
    this.metricsGridEl = reportMetricsGridEl;
    this.recommendationsEl = reportRecommendationsEl;
    this.detailedEl = reportDetailedEl;
    this.premiumOverlayEl = premiumOverlayEl;
    this.premiumCtaEl = premiumCtaEl;
    this.premiumStatusEl = premiumStatusEl;
    this.showReportBtn = showReportBtnEl;

    // Rapor butonu (tekrar acma)
    this.showReportBtn?.addEventListener('click', () => this.open());

    // Kapat butonlari
    this.closeBtn?.addEventListener('click', () => this.close());
    this.backdropEl?.addEventListener('click', (e) => {
      if (e.target === this.backdropEl) this.close();
    });

    // ESC ile kapat
    this._onKeydown = (e) => {
      if (e.key === 'Escape' && this.backdropEl?.classList.contains('open')) {
        this.close();
      }
    };
    document.addEventListener('keydown', this._onKeydown);

    this._onPremiumClick = () => this._startPremiumCheckout();
    this.premiumCtaEl?.addEventListener('click', this._onPremiumClick);

    this._unsubscribePremium = premiumAccess.subscribe(() => this._syncPremiumState());
    premiumAccess.bootstrap().then(() => this._syncPremiumState());

    // Event dinleyiciler
    this._onReportReady = (report) => this._renderReport(report);
    eventBus.on(EVENTS.DIAGNOSTIC_REPORT_READY, this._onReportReady);
  }

  // === PUBLIC ===

  open() {
    this.backdropEl?.classList.add('open');
    this._trapFocus();
  }

  close() {
    this.backdropEl?.classList.remove('open');
    this._releaseFocus();
  }

  destroy() {
    eventBus.off(EVENTS.DIAGNOSTIC_REPORT_READY, this._onReportReady);
    document.removeEventListener('keydown', this._onKeydown);
    this.premiumCtaEl?.removeEventListener('click', this._onPremiumClick);
    this._unsubscribePremium?.();
    this._releaseFocus();
  }

  // === PRIVATE: Focus Trap ===

  _trapFocus() {
    if (!this.panelEl) return;
    this._previouslyFocused = document.activeElement;

    this._onFocusTrap = (e) => {
      if (e.key !== 'Tab' || !this.panelEl) return;
      const focusable = this.panelEl.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', this._onFocusTrap);

    // Focus close button on open
    this.closeBtn?.focus();
  }

  _releaseFocus() {
    if (this._onFocusTrap) {
      document.removeEventListener('keydown', this._onFocusTrap);
      this._onFocusTrap = null;
    }
    this._previouslyFocused?.focus();
    this._previouslyFocused = null;
  }

  // === PRIVATE: Helpers ===

  _buildStars(count) {
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
    if (!this.premiumCtaEl) return;

    const originalText = this.premiumCtaEl.textContent;
    this.premiumCtaEl.disabled = true;
    this.premiumCtaEl.textContent = 'Opening checkout...';
    this._setPremiumStatus('Redirecting to secure checkout.');

    try {
      await premiumAccess.startCheckout();
    } catch (err) {
      this.premiumCtaEl.disabled = false;
      this.premiumCtaEl.textContent = originalText;
      this._setPremiumStatus('Checkout is not configured yet.');
      log.warning('Freemius checkout could not start', { error: err.message });
    }
  }

  _syncPremiumState() {
    if (premiumAccess.isUnlocked()) {
      this.detailedEl?.classList.remove('blurred');
      this.premiumOverlayEl?.classList.add('hidden');
      this._setPremiumStatus('');
      return;
    }

    this.detailedEl?.classList.add('blurred');
    this.premiumOverlayEl?.classList.remove('hidden');
  }

  _setPremiumStatus(message) {
    if (!this.premiumStatusEl) return;
    this.premiumStatusEl.textContent = message;
    this.premiumStatusEl.hidden = !message;
  }

  // === PRIVATE: Render ===

  _renderReport(report) {
    if (!report) return;

    const free = reportEvaluator.evaluateFree(report);
    const detailed = reportEvaluator.evaluateDetailed(report);

    // Score badge
    this._renderScoreBadge(free.overall);

    // Overall skor
    this._renderOverall(free.overall, free.summary);

    // Bulgular
    this._renderFindings(free.findings);

    // Premium: Metrikler
    this._renderMetrics(detailed.metrics);

    // Premium: Oneriler
    this._renderRecommendations(detailed.recommendations);

    this._syncPremiumState();

    // Rapor butonunu goster (tekrar acma icin)
    if (this.showReportBtn) this.showReportBtn.style.display = '';

    // Popup ac
    this.open();

    log.ui('Report popup rendered', { score: free.overall.score, findingCount: free.findings.length });
  }

  _renderScoreBadge(overall) {
    if (!this.scoreBadgeEl) return;
    const stars = this._buildStars(overall.stars);
    this.scoreBadgeEl.textContent = `${stars} ${overall.label}`;
    this.scoreBadgeEl.dataset.color = overall.color;
  }

  _renderOverall(overall, summary) {
    if (!this.overallEl) return;

    const emoji = overall.score === 'good' ? '\u2713' : overall.score === 'fair' ? '!' : '\u2715';
    const stars = this._buildStars(overall.stars);

    const indicator = this._createElement('div', 'report-overall-indicator', emoji);
    indicator.dataset.color = overall.color;

    const textWrap = this._createElement('div', 'report-overall-text');
    textWrap.append(
      this._createElement('div', 'report-overall-label', overall.label),
      this._createElement('div', 'report-overall-stars', stars)
    );

    this.overallEl.replaceChildren(
      indicator,
      textWrap,
      this._createElement('div', 'report-overall-summary', summary)
    );
  }

  _renderFindings(findings) {
    if (!this.findingsEl) return;

    if (findings.length === 0) {
      this.findingsEl.replaceChildren(
        this._createIconTextItem(
          'finding-item finding-item--good',
          '\u2713',
          'No issues detected. Your audio quality looks good.'
        )
      );
      return;
    }

    const items = findings.map(f => {
      const severity = f.severity === 'critical' ? 'critical' : 'warning';
      return this._createIconTextItem(
        `finding-item finding-item--${severity}`,
        severity === 'critical' ? '!' : '~',
        f.message
      );
    });
    this.findingsEl.replaceChildren(...items);
  }

  _renderMetrics(metrics) {
    if (!this.metricsGridEl || !metrics) return;

    const cards = metrics.map(m => {
      const val = m.value != null ? m.value : '--';
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

  _renderRecommendations(recommendations) {
    if (!this.recommendationsEl) return;

    if (!recommendations || recommendations.length === 0) {
      this.recommendationsEl.replaceChildren(
        this._createIconTextItem('rec-item', '\u2192', 'No additional recommendations found.')
      );
      return;
    }

    this.recommendationsEl.replaceChildren(
      ...recommendations.map(r => this._createIconTextItem('rec-item', '\u2192', r.message))
    );
  }
}

const reportPanelUI = new ReportPanelUI();
export default reportPanelUI;
