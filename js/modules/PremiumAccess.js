/**
 * PremiumAccess - Account-backed lifetime access and Freemius purchase handling.
 *
 * Configured accounts use an HttpOnly session cookie for checkout, purchase
 * linking and detailed reports. Only explicitly disabled account deployments
 * retain the legacy signed redirect / bearer token flow. Node/Worker authorizes
 * every detailed request; Freemius secrets and Google credentials stay private.
 */
import eventBus from './EventBus.js';
import { EVENTS } from './constants.js';
import { log } from './utils.js';
import accountAccess from './AccountAccess.js';
import { projectArchiveReport } from './ArchiveReport.js';

const STORAGE_KEY = 'micprobe:premium-access:v1';
const CONFIG_ENDPOINT = '/api/freemius/config';
const VERIFY_ENDPOINT = '/api/freemius/verify';
const DETAILED_REPORT_ENDPOINT = '/api/report/detailed';
const PENDING_PURCHASE_KEY = 'micprobe:pending-account-purchase:v1';

const FREEMIUS_PARAM_NAMES = [
  'action',
  'checkout_state',
  'amount',
  'billing_cycle',
  'currency',
  'email',
  'expiration',
  'license_id',
  'payment_id',
  'plan_id',
  'pricing_id',
  'quota',
  'signature',
  'subscription_id',
  'tax',
  'trial',
  'trial_ends_at',
  'user_id'
];

class PremiumAccess {
  constructor() {
    this.entitlement = this._readStoredEntitlement();
    this.config = null;
    this.lastError = '';
    this.listeners = new Set();
    this.bootstrapPromise = null;
    // Freemius geri dönüş URL'sini modül yüklenir yüklenmez yakala; boylece
    // config fetch beklenirken router URL'yi degistirse bile imza kaybolmaz.
    this.redirectHref = window.location.href;
    try { this.pendingPurchase = sessionStorage.getItem(PENDING_PURCHASE_KEY) || ''; }
    catch { this.pendingPurchase = ''; }
    this._unsubscribeAccount = accountAccess.subscribe(state => {
      const identityChanged = this._accountUserId !== state.user?.id;
      this._accountUserId = state.user?.id;
      this._notify();
      if (identityChanged && state.user && !state.premium?.pending && this.pendingPurchase) this._completeAccountPurchase();
    });
  }

  bootstrap() {
    if (!this.bootstrapPromise) {
      this.bootstrapPromise = this._processRedirectIfPresent();
    }
    return this.bootstrapPromise;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  getState() {
    const account = accountAccess.getState();
    return {
      unlocked: this.isUnlocked(),
      pending: !!(account.user && account.premium?.pending),
      entitlement: this.entitlement,
      lastError: this.lastError,
      userId: account.user?.id || null
    };
  }

  isUnlocked() {
    const account = accountAccess.getState();
    if (!account.ready || account.configured !== false) {
      return !!(account.user && !account.error && !account.premium?.pending && account.premium?.unlocked);
    }
    if (!this.entitlement?.verified) return false;
    if (!this.entitlement.accessToken) return false;

    if (this.config?.mode && this.entitlement.mode && this.entitlement.mode !== this.config.mode) {
      return false;
    }

    const expiry = this.entitlement.expiresAt;
    if (!expiry) return true;

    const expiresAt = Date.parse(expiry.replace(' ', 'T'));
    if (!Number.isFinite(expiresAt)) return true;

    return expiresAt > Date.now();
  }

  getAccessToken() {
    return accountAccess.getState().configured === false && this.isUnlocked() ? this.entitlement?.accessToken || '' : '';
  }

  async fetchDetailedReport(report) {
    const accessToken = this.getAccessToken();
    const expectedOwner = accountAccess.getState().user?.id || 'anonymous';
    if (report?.run?.accountOwnerId && report.run.accountOwnerId !== expectedOwner) throw new Error('account_changed');
    if (!this.isUnlocked()) {
      throw new Error('premium_access_required');
    }

    const response = await fetch(DETAILED_REPORT_ENDPOINT, {
      method: 'POST',
      credentials: 'same-origin',
      signal: AbortSignal.timeout(15000),
      headers: {
        Accept: 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        'X-MicProbe-Request': '1',
        ...(accessToken ? {} : { 'X-MicProbe-Account': expectedOwner }),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ report: projectArchiveReport(report) })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) {
      if (!accessToken) {
        // The session may expire or a license may be revoked while the report
        // stays open. Refresh identity/access without retrying the old report.
        await accountAccess.refreshRejectedAccess(payload.error, expectedOwner);
      }
      if (accessToken && this.entitlement?.accessToken === accessToken && [403, 404].includes(response.status)) {
        this.entitlement = null;
        this.lastError = payload.error === 'license_restore_required'
          ? 'Open Sign in → Restore an earlier purchase and enter the license key from your purchase email.'
          : 'This purchase is no longer active. Check your purchase or restore a current license from Sign in.';
        this._writeStoredEntitlement(null);
        this._notify();
        if (payload.error === 'license_restore_required') this._showStatusMessage('Restore your earlier purchase from Sign in using the license key in your purchase email.', 'warning');
      }
      throw new Error(payload.error || 'premium_report_failed');
    }
    if (!accessToken && (accountAccess.getState().user?.id || 'anonymous') !== expectedOwner) {
      throw new Error('account_changed');
    }
    if (accessToken && payload.entitlement && this.entitlement?.accessToken === accessToken) {
      this.lastError = '';
      this.entitlement = this._normalizeEntitlement(payload.entitlement);
      this._writeStoredEntitlement(this.entitlement);
      this._notify();
    }
    return payload.detailed;
  }

  async restoreLegacyPurchase(licenseKey) {
    await accountAccess.bootstrap();
    if (accountAccess.getState().configured !== false) throw new Error('account_sign_in_required');
    const response = await fetch('/api/freemius/restore', {
      method: 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(15000),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-MicProbe-Request': '1' },
      body: JSON.stringify({ licenseKey })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) throw new Error(payload.error || 'invalid_license_key');
    this.lastError = '';
    this.entitlement = this._normalizeEntitlement(payload.entitlement);
    this._writeStoredEntitlement(this.entitlement);
    this._notify();
  }

  async startCheckout() {
    await accountAccess.bootstrap();
    if (accountAccess.getState().configured !== false) return accountAccess.startCheckout();
    const config = await this._loadCheckoutConfig();
    const checkoutUrl = this._buildCheckoutUrl(config);

    if (!checkoutUrl) {
      throw new Error('freemius_checkout_not_configured');
    }

    window.location.assign(checkoutUrl);
  }

  async _processRedirectIfPresent() {
    // Parametreleri config fetch'inden ONCE, yakalanan snapshot'tan oku.
    const params = new URL(this.redirectHref).searchParams;
    const hasSignature = params.has('signature');

    await this._loadCheckoutConfig();
    await accountAccess.bootstrap();

    const accountReturn = hasSignature && (accountAccess.getState().configured !== false || params.has('checkout_state'));
    if (accountReturn || this.pendingPurchase) {
      if (accountReturn) {
        this.pendingPurchase = this.redirectHref;
        try { sessionStorage.setItem(PENDING_PURCHASE_KEY, this.pendingPurchase); }
        catch { /* The current page still owns the pending return. */ }
      }
      this._cleanFreemiusParamsFromUrl();
      if (!accountAccess.requireSignIn('purchase')) {
        this._showStatusMessage('Sign in to finish linking your purchase. Your test is preserved.', 'warning');
        return this.getState();
      }
      return this._completeAccountPurchase();
    }

    if (!hasSignature) {
      this._notify();
      return this.getState();
    }

    try {
      const verifyUrl = `${VERIFY_ENDPOINT}?url=${encodeURIComponent(this.redirectHref)}`;
      const response = await fetch(verifyUrl, { headers: { Accept: 'application/json' } });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || 'freemius_redirect_verification_failed');
      }

      this.entitlement = this._normalizeEntitlement(payload.entitlement);
      this._writeStoredEntitlement(this.entitlement);
      this._showStatusMessage('Premium unlocked. Detailed fixes are now available.', 'success', 'idle');
      this._notify();
      log.ui('Freemius premium access unlocked', {
        mode: this.entitlement.mode,
        action: this.entitlement.action,
        planId: this.entitlement.planId
      });
    } catch (err) {
      this._showStatusMessage(`Payment returned, but verification failed: ${err.message}.`, 'error', 'error');
      this._notify();
      log.error('Freemius redirect verification failed', { error: err.message });
    } finally {
      // Imza parametreleri basari/hata farketmeksizin URL'den silinir; kirli
      // URL'de F5 -> ayni imza tekrar verify edilir -> replay guard 409
      // (redirect_already_used) dongusu olusurdu.
      this._cleanFreemiusParamsFromUrl();
    }

    return this.getState();
  }

  _completeAccountPurchase() {
    if (this.purchasePromise) return this.purchasePromise;
    if (!this.pendingPurchase || this.getState().pending) return Promise.resolve(this.getState());
    const ownerId = accountAccess.getState().user?.id;
    const purchaseUrl = this.pendingPurchase;
    this.purchasePromise = (async () => {
      try {
        await accountAccess.api('/purchase', { method: 'POST', body: { url: purchaseUrl } });
        if (accountAccess.getState().user?.id !== ownerId || this.pendingPurchase !== purchaseUrl) return this.getState();
        this.pendingPurchase = '';
        try { sessionStorage.removeItem(PENDING_PURCHASE_KEY); } catch { /* Storage can be unavailable. */ }
        await accountAccess.refresh();
        if (accountAccess.getState().user?.id !== ownerId) return this.getState();
        if (this.isUnlocked()) {
          this._showStatusMessage('Lifetime Premium is linked to your account. Test again anytime.', 'success', 'idle');
        } else if (accountAccess.getState().error) {
          this._showStatusMessage('Your purchase was linked. Reconnect from Account to check Premium access.', 'warning');
        } else {
          this._showStatusMessage('Your purchase was linked, but it is no longer active. Check your purchase from Account. You can still test again.', 'warning');
        }
      } catch {
        if (accountAccess.getState().user?.id !== ownerId || this.pendingPurchase !== purchaseUrl) return this.getState();
        this._showStatusMessage(this.getState().pending
          ? 'Purchase verification is pending. Use Retry purchase verification in Account; you do not need to buy again.'
          : 'Your purchase could not be linked yet. Sign in with the account used for checkout and retry by reloading this page.', 'warning');
      }
      this._notify();
      return this.getState();
    })().finally(() => { this.purchasePromise = null; });
    return this.purchasePromise;
  }

  async _loadCheckoutConfig() {
    try {
      const response = await fetch(CONFIG_ENDPOINT, { headers: { Accept: 'application/json' } });
      if (!response.ok) {
        this.config = null;
        return {};
      }
      this.config = await response.json();
      return this.config;
    } catch (err) {
      this.config = null;
      log.warning('Freemius config endpoint unavailable', { error: err.message });
      return {};
    }
  }

  _buildCheckoutUrl(config) {
    if (config.configured === false || (config.mode === 'sandbox' && config.sandboxActive !== true)) {
      return '';
    }

    if (config.checkoutUrl) {
      return this._appendCheckoutParams(config.checkoutUrl, config);
    }

    if (!config.productId || !config.planId) {
      return '';
    }

    const base = `https://checkout.freemius.com/product/${encodeURIComponent(config.productId)}/plan/${encodeURIComponent(config.planId)}/`;
    return this._appendCheckoutParams(base, config);
  }

  _appendCheckoutParams(rawUrl, config) {
    const url = new URL(rawUrl, window.location.origin);
    if (url.protocol !== 'https:' || url.hostname !== 'checkout.freemius.com') return '';
    if (config.mode === 'sandbox' && (!/^[a-f0-9]{32}$/i.test(url.searchParams.get('sandbox') || '')
      || !/^\d{9,13}$/.test(url.searchParams.get('s_ctx_ts') || ''))) return '';
    const currentUrl = new URL(window.location.href);
    currentUrl.search = '';

    url.searchParams.set('success_url', config.successUrl || currentUrl.toString());
    url.searchParams.set('cancel_url', currentUrl.toString());
    url.searchParams.set('title', config.title || 'MicProbe Premium');
    url.searchParams.set('show_confirmation_dialog', 'false');

    if (config.billingCycle) {
      url.searchParams.set('billing_cycle', config.billingCycle);
    }

    return url.toString();
  }

  _normalizeEntitlement(data = {}) {
    return {
      verified: true,
      verifiedAt: new Date().toISOString(),
      mode: data.mode || '',
      action: data.action || '',
      planId: data.planId || '',
      pricingId: data.pricingId || '',
      billingCycle: data.billingCycle || '',
      expiresAt: data.expiration || data.trialEndsAt || '',
      tokenExpiresAt: data.tokenExpiresAt || '',
      accessToken: data.accessToken || ''
    };
  }

  _readStoredEntitlement() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  _writeStoredEntitlement(entitlement) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(entitlement));
    } catch (err) {
      log.warning('Premium entitlement could not be persisted', { error: err.message });
    }
  }

  _showStatusMessage(message, tone = 'warning', status = 'idle') {
    eventBus.emit(EVENTS.UI_MESSAGE, { message, tone, status });
  }

  _cleanFreemiusParamsFromUrl() {
    const url = new URL(window.location.href);
    for (const name of FREEMIUS_PARAM_NAMES) {
      url.searchParams.delete(name);
    }
    window.history.replaceState({}, document.title, `${url.pathname}${url.search}${url.hash}`);
  }

  _notify() {
    const state = this.getState();
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}

const premiumAccess = new PremiumAccess();
export default premiumAccess;
