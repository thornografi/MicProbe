import googleRedirectState, { requiresGoogleRedirect } from './GoogleRedirectState.js';
const VISIT_KEY = 'micprobe:google-prompt:v1';
// Server challenges last ten minutes. Retire the UI before its proof expires.
const CHALLENGE_LIFETIME_MS = 9 * 60 * 1000;
let scriptPromise;

function loadGoogle() {
  if (globalThis.google?.accounts?.id) return Promise.resolve(globalThis.google.accounts.id);
  if (!scriptPromise) scriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const fail = () => {
      clearTimeout(timeout);
      script.remove();
      scriptPromise = null;
      reject(new Error('google_unavailable'));
    };
    const timeout = setTimeout(fail, 15000);
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = () => {
      if (!globalThis.google?.accounts?.id) return fail();
      clearTimeout(timeout);
      resolve(globalThis.google.accounts.id);
    };
    script.onerror = fail;
    document.head.append(script);
  });
  return scriptPromise;
}

/** One owner for GIS, browser challenges and callbacks from both entry points. */
export class GoogleSignIn {
  constructor({ account, canPrompt, onPromptCredential, onPromptError = () => {}, load = loadGoogle,
    storage = () => globalThis.sessionStorage, now = Date.now, useRedirect = requiresGoogleRedirect(),
    redirectState = googleRedirectState } = {}) {
    Object.assign(this, { account, canPrompt, onPromptCredential, onPromptError, load, storage, now, useRedirect, redirectState });
    this.revision = 0;
    this.offered = false;
    this.active = null;
  }
  markVisit() {
    this.offered = true;
    try { this.storage()?.setItem(VISIT_KEY, '1'); } catch { /* Private storage may be unavailable. */ }
  }
  cancel() {
    ++this.revision;
    clearTimeout(this.expiryTimer);
    this.active?.cleanup?.();
    this.active = null;
    this.kind = null;
    this.gsi?.cancel?.();
  }
  cancelPrompt() { if (this.kind === 'prompt') this.cancel(); }
  suppress() { this.markVisit(); this.cancel(); }
  async offer() {
    if (this.useRedirect) return;
    let visited = this.offered;
    try { visited ||= !!this.storage()?.getItem(VISIT_KEY); } catch { /* In-memory suppression still applies. */ }
    if (visited || !this.canPrompt()) return;
    // FedCM may withhold display/dismiss notifications; count the attempt itself.
    this.markVisit();
    try {
      await this.start({ kind: 'prompt', isCurrent: this.canPrompt, onCredential: this.onPromptCredential,
        onError: this.onPromptError, render: gsi => gsi.prompt() });
    } catch { /* Optional prompts never interrupt testing; the sign-in button remains available. */ }
  }
  renderButton(container, { isCurrent, onCredential, onError, redirect = {} }) {
    this.markVisit();
    let observer;
    return this.start({ kind: 'button', isCurrent, onCredential, onError, redirect,
      cleanup: () => { observer?.disconnect(); container.replaceChildren(); }, render: gsi => {
        const attempt = this.active;
        let renderedWidth;
        const draw = () => {
          if (this.active !== attempt || attempt.consumed || !isCurrent()) return;
          const width = Math.min(260, Math.floor(container.clientWidth));
          if (width <= 0 || width === renderedWidth) return;
          renderedWidth = width;
          container.replaceChildren();
          gsi.renderButton(container, { type: 'standard', theme: 'outline', size: 'large',
            text: 'continue_with', shape: 'rectangular', width });
        };
        draw();
        if (globalThis.ResizeObserver) {
          observer = new ResizeObserver(() => {
            try { draw(); } catch (error) { this.cancel(); onError?.(error); }
          });
          observer.observe(container);
        }
      } });
  }
  async start({ kind, isCurrent, onCredential, onError, render, cleanup, redirect = {} }) {
    this.cancel();
    this.kind = kind;
    const revision = this.revision;
    const expiresAt = this.now() + CHALLENGE_LIFETIME_MS;
    let config, gsi;
    const redirecting = kind === 'button' && this.useRedirect;
    try { [config, gsi] = await Promise.all([
      redirecting ? this.account.api('/google/redirect/start', { method: 'POST',
        body: { confirming: redirect.confirming === true, switching: redirect.intent === 'switch', rememberMe: redirect.rememberMe === true } })
        : this.account.getSignInConfig(), this.load()
    ]); }
    catch (error) {
      if (revision !== this.revision) return;
      this.cancel();
      throw error;
    }
    if (revision !== this.revision || !isCurrent()) return;
    if (!config.configured || !config.googleClientId || !config.nonce) throw new Error('account_unavailable');
    if (this.now() >= expiresAt) throw new Error('sign_in_expired');
    if (redirecting) {
      if (config.loginUri !== `${globalThis.location.origin}/api/account/google/redirect`) throw new Error('account_unavailable');
      this.redirectState.save({ nonce: config.nonce, mode: redirect.confirming ? 'confirm' : redirect.intent === 'switch' ? 'switch' : 'signin',
        owner: this.account.getState().user?.id, snapshot: redirect.snapshot?.(), intent: redirect.intent });
    }
    this.gsi = gsi;
    const attempt = { isCurrent, onCredential, onError, expiresAt, consumed: false, cleanup };
    this.active = attempt;
    // Reinitialize for a new browser challenge. Superseded callbacks cannot
    // sign in or inherit the intent of a later button/checkout action.
    gsi.initialize({ client_id: config.googleClientId, nonce: config.nonce,
      auto_select: false, button_auto_select: false, use_fedcm_for_button: true,
      itp_support: false, context: 'signin', ux_mode: redirecting ? 'redirect' : 'popup',
      ...(redirecting ? { login_uri: config.loginUri } : {}),
      callback: response => this.accept(response, attempt) });
    this.expiryTimer = setTimeout(() => {
      if (this.active !== attempt) return;
      this.cancel();
      onError?.(new Error('sign_in_expired'));
    }, expiresAt - this.now());
    this.expiryTimer.unref?.();
    try { render(gsi); }
    catch (error) { this.cancel(); throw error; }
  }
  async accept(response, attempt) {
    if (this.active !== attempt || attempt.consumed || !attempt.isCurrent()) return;
    attempt.consumed = true;
    clearTimeout(this.expiryTimer);
    try {
      if (this.now() >= attempt.expiresAt) throw new Error('sign_in_expired');
      if (!response?.credential) throw new Error('invalid_identity');
      await attempt.onCredential(response.credential);
    } catch (error) { attempt.onError?.(error); }
    finally { if (this.active === attempt) this.cancel(); }
  }
}
