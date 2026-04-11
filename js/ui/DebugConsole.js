/**
 * DebugConsole - Debug fonksiyonlari ve event binding
 * addEventListener ile DOM handler'lari baglar (inline onclick yerine)
 */
import { log } from '../modules/utils.js';
import { EVENTS } from '../modules/constants.js';

class DebugConsole {
  constructor() {
    // Bagimliliklar
    this.deps = {
      eventBus: null,
      logger: null,
      logManager: null,
      monitor: null,
      audioEngine: null
    };

    // Cleanup icin handler referanslari
    this._handlers = [];
  }

  /**
   * Bagimliliklari set et
   */
  init(deps) {
    Object.assign(this.deps, deps);
  }

  /**
   * DOM event listener'lari bagla (inline onclick yerine)
   * Console globalleri de development icin kayit edilir
   */
  registerGlobals() {
    const { eventBus, logger, logManager, monitor, audioEngine } = this.deps;

    // --- Action handlers ---
    const clearLog = () => eventBus.emit(EVENTS.LOG_CLEAR);

    const copyAllLogs = async () => {
      const btn = document.getElementById('copyLogsBtn');
      const success = await logger.copyAll();
      if (success && btn) {
        btn.classList.add('copied');
        setTimeout(() => btn.classList.remove('copied'), 1500);
      } else if (!success) {
        log.error('Copy failed', {});
      }
    };

    const exportLogs = () => logManager.exportJSON();

    const filterLogs = (category) => {
      if (category === 'all') {
        logger.showAll();
      } else {
        logger.filterByCategory(category);
      }
      document.querySelectorAll('.btn-filter').forEach(btn => btn.classList.remove('active'));
      const activeBtn = document.querySelector(`[data-category="${category}"]`);
      if (activeBtn) activeBtn.classList.add('active');
    };

    const getLogStats = () => {
      const stats = logManager.getStats();
      const statsText = Object.entries(stats)
        .map(([cat, count]) => `${cat}: ${count}`)
        .join(' | ');
      log.system(`Stats: ${statsText}`);
      console.table(stats);
      return stats;
    };

    const exportDiagnosticReport = () => {
      try {
        const { diagnosticReportBuilder } = this.deps;
        if (!diagnosticReportBuilder) { log.warning('DiagnosticReportBuilder not connected yet'); return null; }
        const report = diagnosticReportBuilder.getLastReport();
        if (!report) { log.warning('No diagnostic report generated yet. Run a test/recording first.'); return null; }
        return diagnosticReportBuilder.exportReport(report);
      } catch (err) {
        log.error('Diagnostic report export error', { error: err.message });
        return null;
      }
    };

    const runSanityChecks = () => {
      const report = logManager.getSanityReport();
      if (report.ok) {
        log.webaudio('Sanity Check: OK (no suspicious findings)', report.summary);
        console.table([]);
        return report;
      }
      log.webaudio(`Sanity Check: ${report.issues.length} findings found`, report.summary);
      for (const issue of report.issues) {
        if (issue.severity === 'error') {
          log.error(`Sanity: ${issue.code} - ${issue.message}`, issue.details);
        } else {
          log.webaudio(`Sanity: ${issue.code} - ${issue.message}`, issue.details);
        }
      }
      console.table(report.issues);
      return report;
    };

    // --- DOM event binding (replaces inline onclick) ---
    const _bind = (id, handler) => {
      const el = document.getElementById(id);
      if (el) { el.addEventListener('click', handler); this._handlers.push({ el, handler }); }
    };

    _bind('clearLogBtn', clearLog);
    _bind('copyLogsBtn', copyAllLogs);
    _bind('exportLogsBtn', exportLogs);
    _bind('logStatsBtn', getLogStats);
    _bind('sanityCheckBtn', runSanityChecks);

    // Filter buttons (event delegation via data-category)
    const filterContainer = document.querySelector('.filter-buttons');
    if (filterContainer) {
      const filterHandler = (e) => {
        const btn = e.target.closest('[data-category]');
        if (btn) filterLogs(btn.dataset.category);
      };
      filterContainer.addEventListener('click', filterHandler);
      this._handlers.push({ el: filterContainer, handler: filterHandler });
    }

    // --- Console globals (development/debugging convenience) ---
    window.clearLog = clearLog;
    window.copyAllLogs = copyAllLogs;
    window.exportLogs = exportLogs;
    window.filterLogs = filterLogs;
    window.getLogStats = getLogStats;
    window.exportDiagnosticReport = exportDiagnosticReport;
    window.runSanityChecks = runSanityChecks;

    const _registerGetter = (name, getter, label) => {
      window[name] = () => { const s = getter(); console.log(`${label}:`, s); return s; };
    };
    _registerGetter('getMonitorState', () => monitor.getWebAudioState(), 'Monitor WebAudio State');
    _registerGetter('getAudioEngineState', () => audioEngine.getState(), 'AudioEngine State');
  }

  /**
   * Tum event listener'lari ve global referanslari temizle
   */
  destroy() {
    // DOM listener'lari kaldir
    for (const { el, handler } of this._handlers) {
      el.removeEventListener('click', handler);
    }
    this._handlers = [];

    // Global referanslari temizle
    const globals = [
      'clearLog', 'copyAllLogs', 'exportLogs', 'filterLogs',
      'getLogStats', 'getMonitorState', 'getAudioEngineState',
      'exportDiagnosticReport', 'runSanityChecks'
    ];
    globals.forEach(name => delete window[name]);
  }
}

// Singleton export
const debugConsole = new DebugConsole();
export default debugConsole;
