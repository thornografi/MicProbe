/**
 * CheckoutStateSnapshot - Freemius checkout donusu icin oturum state korumasi
 *
 * Checkout ayni sekmede tam sayfa navigasyonla acilir (PremiumAccess.startCheckout);
 * donus tam reload oldugu icin tum bellek-ici state (rapor, profil) kaybolur.
 * Bu modul checkout'a gitmeden hemen once snapshot'i sessionStorage'a yazar,
 * app.js hesap kimligi dogrulandiktan sonra consume({ ownerId }) ile tek seferlik geri yukler.
 *
 * sessionStorage tercihi: ayni sekmede cross-origin gidis-donuste kalicidir
 * (OAuth-redirect deseni), sekme-scoped oldugu icin baska sekmedeki MicProbe
 * ornegine sizmaz, sekme kapaninca otomatik temizlenir. Success/cancel ayrimi
 * yapilmaz - iki donuste de ayni hesabin raporu geri gelir (premium kilidi ayri katman).
 */
import { PROFILES } from './Config.js';
import { CHECKOUT_SNAPSHOT } from './constants.js';
import { log } from './utils.js';

const STORAGE_KEY = 'micprobe:checkout-snapshot:v1';

export class CheckoutStateSnapshot {
  constructor({ storage = globalThis.sessionStorage } = {}) { this.storage = storage; }
  /**
   * Checkout'a gitmeden hemen once cagirilir. Rapor yoksa no-op.
   * Hata checkout'u BLOKLAMAZ - snapshot best-effort.
   * @param {Object} data - { report, profileId, ownerId }
   */
  save({ report, profileId, ownerId = null } = {}) {
    if (!report) return;
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify({
        report,
        ownerId,
        profileId: profileId || null,
        savedAt: Date.now()
      }));
    } catch (err) {
      log.warning('Checkout snapshot could not be saved', { error: err.message });
    }
  }

  /**
   * Read without consuming: a different account must not destroy the owner's
   * pre-checkout report. Consumption happens only after session ownership matches.
   * @returns {{ report: Object|null, profileId: string|null, ownerId: string|null } | null}
   */
  peek() {
    let raw = null;
    try {
      raw = this.storage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
    if (!raw) return null;

    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!data || typeof data !== 'object') return null;

    const age = Date.now() - (data.savedAt || 0);
    if (!Number.isFinite(age) || age < 0 || age > CHECKOUT_SNAPSHOT.MAX_AGE_MS) {
      log.system('Checkout snapshot expired, restore skipped', { ageMs: age });
      return null;
    }

    return {
      report: data.report || null,
      ownerId: typeof data.ownerId === 'string' ? data.ownerId : null,
      profileId: (data.profileId && PROFILES[data.profileId]) ? data.profileId : null
    };
  }

  consume({ ownerId = null } = {}) {
    const snapshot = this.peek();
    if (!snapshot || snapshot.ownerId !== ownerId) return null;
    try { this.storage.removeItem(STORAGE_KEY); }
    catch { return null; }
    return snapshot;
  }
}

// Singleton
const checkoutStateSnapshot = new CheckoutStateSnapshot();
export default checkoutStateSnapshot;
