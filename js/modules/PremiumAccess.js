/**
 * PremiumAccess - Freemius checkout and signed redirect handling.
 *
 * The browser never receives the Freemius product secret. Redirect signatures
 * are verified by server.js, then a local entitlement unlocks the report UI.
 */
import { log } from './utils.js';

const STORAGE_KEY = 'micprobe:premium-access:v1';
const CONFIG_ENDPOINT = '/api/freemius/config';
const VERIFY_ENDPOINT = '/api/freemius/verify';

const FREEMIUS_PARAM_NAMES = [
  'action',
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
    this.listeners = new Set();
    this.bootstrapPromise = null;
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
    return {
      unlocked: this.isUnlocked(),
      entitlement: this.entitlement
    };
  }

  isUnlocked() {
    if (!this.entitlement?.verified) return false;

    if (this.config?.mode && this.entitlement.mode && this.entitlement.mode !== this.config.mode) {
      return false;
    }

    const expiry = this.entitlement.expiresAt;
    if (!expiry) return true;

    const expiresAt = Date.parse(expiry.replace(' ', 'T'));
    if (!Number.isFinite(expiresAt)) return true;

    return expiresAt > Date.now();
  }

  async startCheckout() {
    const config = await this._loadCheckoutConfig();
    const checkoutUrl = this._buildCheckoutUrl(config);

    if (!checkoutUrl) {
      throw new Error('freemius_checkout_not_configured');
    }

    window.location.assign(checkoutUrl);
  }

  async _processRedirectIfPresent() {
    await this._loadCheckoutConfig();

    const params = new URLSearchParams(window.location.search);
    if (!params.has('signature')) {
      this._notify();
      return this.getState();
    }

    try {
      const verifyUrl = `${VERIFY_ENDPOINT}?url=${encodeURIComponent(window.location.href)}`;
      const response = await fetch(verifyUrl, { headers: { Accept: 'application/json' } });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || 'freemius_redirect_verification_failed');
      }

      this.entitlement = this._normalizeEntitlement(payload.entitlement);
      this._writeStoredEntitlement(this.entitlement);
      this._cleanFreemiusParamsFromUrl();
      this._notify();
      log.ui('Freemius premium access unlocked', {
        mode: this.entitlement.mode,
        action: this.entitlement.action,
        planId: this.entitlement.planId,
        licenseId: this.entitlement.licenseId
      });
    } catch (err) {
      this._notify();
      log.error('Freemius redirect verification failed', { error: err.message });
    }

    return this.getState();
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
    const currentUrl = new URL(window.location.href);
    currentUrl.search = '';

    url.searchParams.set('success_url', config.successUrl || currentUrl.toString());
    url.searchParams.set('cancel_url', currentUrl.toString());
    url.searchParams.set('title', config.title || 'MicProbe Premium');

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
      email: data.email || '',
      userId: data.userId || '',
      planId: data.planId || '',
      pricingId: data.pricingId || '',
      paymentId: data.paymentId || '',
      subscriptionId: data.subscriptionId || '',
      licenseId: data.licenseId || '',
      billingCycle: data.billingCycle || '',
      currency: data.currency || '',
      amount: data.amount || '',
      expiresAt: data.expiration || data.trialEndsAt || ''
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
