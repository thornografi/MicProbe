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

    // Premium blur uygula
    this.detailedEl?.classList.add('blurred');
    this.premiumOverlayEl?.classList.remove('hidden');

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

    this.overallEl.innerHTML = `
      <div class="report-overall-indicator" data-color="${overall.color}">${emoji}</div>
      <div class="report-overall-text">
        <div class="report-overall-label">${overall.label}</div>
        <div class="report-overall-stars">${stars}</div>
      </div>
      <div class="report-overall-summary">${summary}</div>
    `;
  }

  _renderFindings(findings) {
    if (!this.findingsEl) return;

    if (findings.length === 0) {
      this.findingsEl.innerHTML = `
        <div class="finding-item finding-item--good">
          <span class="finding-icon">\u2713</span>
          <span>No issues detected. Your audio quality looks good.</span>
        </div>
      `;
      return;
    }

    this.findingsEl.innerHTML = findings.map(f => `
      <div class="finding-item finding-item--${f.severity}">
        <span class="finding-icon">${f.severity === 'critical' ? '!' : '~'}</span>
        <span>${f.message}</span>
      </div>
    `).join('');
  }

  _renderMetrics(metrics) {
    if (!this.metricsGridEl || !metrics) return;

    this.metricsGridEl.innerHTML = metrics.map(m => {
      const val = m.value != null ? m.value : '--';
      return `
        <div class="metric-card" data-rating="${m.rating}">
          <div class="metric-card-label">${m.label}</div>
          <div class="metric-card-value">${val}<span class="metric-card-unit">${m.unit}</span></div>
        </div>
      `;
    }).join('');
  }

  _renderRecommendations(recommendations) {
    if (!this.recommendationsEl) return;

    if (!recommendations || recommendations.length === 0) {
      this.recommendationsEl.innerHTML = '<div class="rec-item"><span class="rec-icon">\u2192</span><span>No additional recommendations found.</span></div>';
      return;
    }

    this.recommendationsEl.innerHTML = recommendations.map(r => `
      <div class="rec-item">
        <span class="rec-icon">\u2192</span>
        <span>${r.message}</span>
      </div>
    `).join('');
  }
}

const reportPanelUI = new ReportPanelUI();
export default reportPanelUI;
