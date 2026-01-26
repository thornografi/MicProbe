/**
 * DebugConsole - HTML onclick ile cagirilan debug fonksiyonlari
 * window.* global fonksiyonlari bu modülde tanimlanir
 */
import { log } from '../modules/utils.js';

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
  }

  /**
   * Bagimliliklari set et
   */
  init(deps) {
    Object.assign(this.deps, deps);
  }

  /**
   * window.* global fonksiyonlari kaydet
   * HTML onclick handler'lari icin gerekli
   */
  registerGlobals() {
    const { eventBus, logger, logManager, monitor, audioEngine } = this.deps;

    // Log temizle
    window.clearLog = () => {
      eventBus.emit('log:clear');
    };

    // Tum loglari kopyala
    window.copyAllLogs = async () => {
      const btn = document.getElementById('copyLogsBtn');
      const success = await logger.copyAll();

      if (success && btn) {
        // Basarili animasyon - CSS ile icon toggle
        btn.classList.add('copied');
        setTimeout(() => btn.classList.remove('copied'), 1500);
      } else if (!success) {
        log.error('Kopyalama basarisiz', {});
      }
    };

    // JSON export
    window.exportLogs = () => {
      logManager.exportJSON();
    };

    // Kategori filtreleme
    window.filterLogs = (category) => {
      if (category === 'all') {
        logger.showAll();
      } else {
        logger.filterByCategory(category);
      }
      // Buton aktiflik durumunu guncelle
      document.querySelectorAll('.btn-filter').forEach(btn => {
        btn.classList.remove('active');
      });
      const activeBtn = document.querySelector(`[data-category="${category}"]`);
      if (activeBtn) activeBtn.classList.add('active');
    };

    // Log istatistikleri
    window.getLogStats = () => {
      const stats = logManager.getStats();
      const statsText = Object.entries(stats)
        .map(([cat, count]) => `${cat}: ${count}`)
        .join(' | ');
      log.system(`Stats: ${statsText}`);
      console.table(stats);
      return stats;
    };

    // Monitor WebAudio state
    window.getMonitorState = () => {
      const state = monitor.getWebAudioState();
      console.log('Monitor WebAudio State:', state);
      return state;
    };

    // AudioEngine state
    window.getAudioEngineState = () => {
      const state = audioEngine.getState();
      console.log('AudioEngine State:', state);
      return state;
    };

    // Sanity checks
    window.runSanityChecks = () => {
      const report = logManager.getSanityReport();

      if (report.ok) {
        log.webaudio('Sanity Check: OK (supheli bulgu yok)', report.summary);
        console.table([]);
        return report;
      }

      log.webaudio(`Sanity Check: ${report.issues.length} bulgu bulundu`, report.summary);

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
  }
}

// Singleton export
const debugConsole = new DebugConsole();
export default debugConsole;
