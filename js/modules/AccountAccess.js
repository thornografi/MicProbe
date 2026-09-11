/** Cookie-backed identity. Google credentials are exchanged once and never persisted. */
export class AccountAccess {
  constructor({ request = (...args) => fetch(...args) } = {}) {
    this.request = request;
    this.state = { ready: false, configured: null, user: null, purchaseLinked: false, premium: { unlocked: false }, error: '' };
    this.listeners = new Set();
    this.intentListeners = new Set();
    this.revision = 0;
    this.pendingIntent = null;
  }

  getState() { return structuredClone(this.state); }
  subscribe(listener) {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }
  subscribeIntent(listener) {
    this.intentListeners.add(listener);
    if (this.pendingIntent) listener(this.pendingIntent);
    return () => this.intentListeners.delete(listener);
  }
  requireSignIn(intent = 'history') {
    if (this.state.user) return true;
    this.pendingIntent = intent;
    this.intentListeners.forEach(listener => listener(intent));
    return false;
  }
  clearIntent() { this.pendingIntent = null; }
  _notify() { this.listeners.forEach(listener => listener(this.getState())); }

  async refreshRejectedAccess(code, expectedOwner) {
    if (!['sign_in_required', 'account_changed', 'premium_access_required', 'already_premium'].includes(code)) return;
    if (code === 'sign_in_required' && expectedOwner === this.state.user?.id) {
      ++this.revision;
      this.state = { ...this.state, user: null, purchaseLinked: false, premium: { unlocked: false }, error: '' };
      this._notify();
    }
    return this.refresh({ sessionOnly: true });
  }

  async api(path, { method = 'GET', body } = {}) {
    const checkOwner = !['/config', '/session', '/google'].includes(path.split('?')[0]);
    const expectedOwner = this.state.user?.id || 'anonymous';
    let response;
    try { response = await this.request(`/api/account${path}`, {
      method,
      credentials: 'same-origin',
      signal: AbortSignal.timeout(15000),
      headers: { Accept: 'application/json', ...(checkOwner ? { 'X-MicProbe-Account': expectedOwner } : {}), ...(method !== 'GET' ? {
        'Content-Type': 'application/json', 'X-MicProbe-Request': '1'
      } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }); } catch (error) {
      const code = error.name === 'TimeoutError' ? 'network_timeout' : 'network_unavailable';
      throw Object.assign(new Error(code), { code });
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) {
      if (checkOwner) await this.refreshRejectedAccess(payload.error, expectedOwner);
      if (response.status === 503 && payload.error === 'billing_temporarily_unavailable'
          && ['/purchase', '/restore', '/checkout'].includes(path) && expectedOwner === this.state.user?.id) {
        await this.refresh({ sessionOnly: true });
      }
      throw Object.assign(new Error(payload.error || 'account_unavailable'), {
        code: payload.error || 'account_unavailable', status: response.status
      });
    }
    if (checkOwner && expectedOwner !== (this.state.user?.id || 'anonymous')) {
      throw Object.assign(new Error('account_changed'), { code: 'account_changed', status: 409 });
    }
    return payload;
  }

  bootstrap() {
    if (!this.bootstrapPromise) this.bootstrapPromise = this.refresh();
    return this.bootstrapPromise;
  }
  async refresh({ sessionOnly = false } = {}) {
    const revision = ++this.revision;
    try {
      const [config, session] = await Promise.all([
        sessionOnly ? { configured: this.state.configured } : this.api('/config?challenge=0'), this.api('/session')
      ]);
      if (revision !== this.revision) return this.getState();
      this.state = {
        ready: true, configured: config.configured === true,
        user: session.user || null, purchaseLinked: !!session.user && session.purchaseLinked === true,
        premium: session.premium || { unlocked: false }, error: ''
      };
    } catch (error) {
      if (revision !== this.revision) return this.getState();
      // Keep the known owner's purchase-management entry on connection failure.
      // It grants no Premium access; the portal endpoint rechecks ownership.
      this.state = { ...this.state, ready: true,
        premium: { unlocked: false, pending: !!this.state.premium?.pending }, error: error.message };
    }
    this._notify();
    return this.getState();
  }
  getSignInConfig() { return this.api('/config'); }
  async signInWithGoogle(credential, { rememberMe = false } = {}) {
    let signedIn;
    try {
      signedIn = await this.api('/google', { method: 'POST', body: { credential, rememberMe: rememberMe === true } });
    } catch (error) {
      if (!error.status || error.status >= 500) {
        // A lost reply may follow a committed session. Never replay the token
        // or continue checkout on an identity we cannot correlate to this reply.
        const state = await this.refresh({ sessionOnly: true });
        if (state.user && !state.error) throw new Error('sign_in_check_account');
      }
      throw error;
    }
    const state = await this.refresh();
    if (!state.user || state.error) throw new Error('account_unavailable');
    if (signedIn.user?.id && signedIn.user.id !== state.user.id) throw new Error('account_changed');
    return state;
  }
  async logout() {
    await this.api('/logout', { method: 'POST', body: {} });
    ++this.revision;
    this.state = { ...this.state, user: null, purchaseLinked: false, premium: { unlocked: false }, error: '' };
    globalThis.google?.accounts?.id?.disableAutoSelect();
    this.clearIntent();
    this._notify();
  }
  async restorePurchase(licenseKey) {
    const owner = this.state.user?.id;
    await this.api('/restore', { method: 'POST', body: { licenseKey } });
    // The link succeeded even if the following session read is interrupted.
    if (owner && this.state.user?.id === owner) this.state.purchaseLinked = true;
    return this.refresh();
  }
  async startCheckout({ isCurrent = () => true } = {}) {
    if (!this.requireSignIn('checkout')) throw new Error('account_sign_in_required');
    if (!isCurrent()) return false;
    if (this.state.premium?.pending) throw new Error('purchase_verification_pending');
    if (this.state.error) throw new Error('account_unavailable');
    if (this.state.premium?.unlocked) throw new Error('already_premium');
    const result = await this.api('/checkout', { method: 'POST', body: {} });
    if (!isCurrent()) return false;
    const url = new URL(result.checkoutUrl);
    if (url.protocol !== 'https:' || url.hostname !== 'checkout.freemius.com') {
      throw new Error('invalid_checkout_url');
    }
    window.location.assign(url.href);
    return true;
  }
}

export default new AccountAccess();
