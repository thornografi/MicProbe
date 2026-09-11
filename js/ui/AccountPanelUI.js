import accountAccess from '../modules/AccountAccess.js';
import { GoogleSignIn } from '../modules/GoogleSignIn.js';
import { FREEMIUS_PORTAL_LOGIN, freemiusPortalUrl } from '../modules/FreemiusPortal.js';
import { createOverlayController } from './OverlayController.js';

function element(tag, className = '', text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}
function button(text, action, className = 'account-button') {
  const node = element('button', className, text);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}
function link(text, href, { newTab = false } = {}) {
  const node = element('a', 'account-link', text);
  node.href = href;
  if (newTab) {
    node.target = '_blank'; node.rel = 'noopener';
    node.setAttribute('aria-label', `${text} (opens in a new tab)`);
  }
  return node;
}
function dateLabel(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Date unavailable';
}
const testDate = entry => dateLabel(entry.report.generatedAt || entry.createdAt);
export default class AccountPanelUI {
  constructor({ history, premiumAccess, onOpenReport, onAccountChanged, onCheckout, onBeforeOpen, getIsBusy, onRestoreLegacyPurchase, getSignInSnapshot, elements = {} } = {}) {
    this.history = history;
    this.premiumAccess = premiumAccess;
    this.onOpenReport = onOpenReport;
    this.onCheckout = onCheckout;
    this.onRestoreLegacyPurchase = onRestoreLegacyPurchase;
    this.onBeforeOpen = onBeforeOpen;
    this.getSignInSnapshot = getSignInSnapshot;
    this.getIsBusy = getIsBusy;
    this.noteDrafts = new Map();
    this.rememberMe = false;
    this.signInRevision = 0;
    this.accountState = accountAccess.getState();
    this.historyState = history.getState();
    this.view = 'account';
    // DOM: elements DI (UIElements) - modul Node'da import edilebilir kalir
    this.dialog = elements.dialog || document.getElementById('accountDialog');
    this.title = elements.title || document.getElementById('accountDialogTitle');
    this.menuButton = elements.menuButton || document.getElementById('accountMenuBtn');
    this.historyButton = elements.historyButton || document.getElementById('reportHistoryBtn');
    this.accountBody = elements.identity || document.getElementById('accountIdentity');
    this.list = elements.historyList || document.getElementById('accountHistoryList');
    this.historySection = this.list?.closest('.account-history');
    this.status = elements.status || document.getElementById('accountStatus');
    this.actions = elements.historyActions || document.getElementById('accountHistoryActions');
    this.navigation = document.getElementById('accountTabs');
    this.tabs = [...(this.navigation?.querySelectorAll('[data-account-tab]') || [])];
    this.tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => this.setView(tab.dataset.accountTab));
      tab.addEventListener('keydown', event => {
        const next = { ArrowLeft: (index + this.tabs.length - 1) % this.tabs.length,
          ArrowRight: (index + 1) % this.tabs.length, Home: 0, End: this.tabs.length - 1 }[event.key];
        if (next === undefined) return;
        event.preventDefault();
        this.setView(this.tabs[next].dataset.accountTab);
        this.tabs[next].focus();
      });
    });
    this.google = new GoogleSignIn({ account: accountAccess,
      canPrompt: () => this.canOfferGoogle(),
      onPromptCredential: credential => accountAccess.signInWithGoogle(credential, { rememberMe: false }),
      onPromptError: error => {
        if (error.message === 'sign_in_expired' || !this.canOfferGoogle()) return;
        this.open();
        this.showError(error);
      }
    });
    // Native <dialog>; ESC (cancel->close), backdrop tiklamasi ve odak geri donusu OverlayController'da.
    // onClose: her kapanis yolunda (ESC, backdrop, buton, programatik) intent temizlenir.
    this.overlay = createOverlayController(this.dialog, {
      adapter: 'dialog',
      closeEls: this.dialog ? [...this.dialog.querySelectorAll('[data-close-account]')] : [],
      triggerEl: this.menuButton,
      onClose: () => { this.cancelSignIn(); this.rememberMe = false; }
    });
    this.menuButton?.addEventListener('click', () => this.open(null, this.menuButton));
    this.historyButton?.addEventListener('click', () => this.open('reports', this.historyButton));
    this.unsubscribeAccount = accountAccess.subscribe(state => {
      const previousId = this.accountState.user?.id;
      const identityChanged = !this.identityRendered || JSON.stringify(this.accountState) !== JSON.stringify(state);
      this.accountState = state;
      if (previousId && previousId !== state.user?.id) {
        onAccountChanged?.();
      }
      if (this.menuButton) {
        this.menuButton.setAttribute('aria-label', state.user ? 'Account' : 'Sign in');
        this.menuButton.textContent = state.user ? 'Account' : 'Sign in';
      }
      if (this.title) this.title.textContent = state.user ? 'Your account' : 'Sign in';
      if (this.historyButton) this.historyButton.hidden = !state.user;
      // A focus/session check must not replace the button and invalidate a consent already in progress.
      if (identityChanged) { this.renderIdentity(); this.identityRendered = true; }
      this.renderHistory();
      this.syncGoogleSignIn();
    });
    this.unsubscribeHistory = history.subscribe(state => { this.historyState = state; this.renderHistory(); });
    this.unsubscribeIntent = accountAccess.subscribeIntent(intent => this.open(intent));
    this.unsubscribePremium = premiumAccess?.subscribe(() => this.renderHistory());
    accountAccess.bootstrap();
  }
  canOfferGoogle() {
    const state = this.accountState;
    return state.ready && state.configured && !state.user && !state.error
      && document.visibilityState === 'visible' && document.body.classList.contains('app-mode')
      && !document.querySelector('dialog[open]') && !this.getIsBusy?.();
  }
  syncGoogleSignIn() {
    if (this.portalConfirmation?.isCurrent()) return;
    if (this.portalConfirmation) this.cancelPortal();
    if (this.accountState.user || this.getIsBusy?.()) this.google.suppress();
    else if (!document.body.classList.contains('app-mode') || document.visibilityState !== 'visible'
      || !this.accountState.ready || !this.accountState.configured || this.accountState.error) this.google.cancel();
    else if (document.querySelector('dialog[open]')) this.google.cancelPrompt();
    else this.google.offer();
  }
  message(text = '') { if (this.status) this.status.textContent = text; }
  setView(view) {
    if (view !== this.view) this.cancelPortal();
    this.view = view;
    this.message();
    this.syncView();
    const body = this.dialog?.querySelector('.account-dialog-body');
    if (body) body.scrollTop = 0;
  }
  syncView() {
    const signedIn = !!this.accountState.user;
    const canRead = signedIn && (this.accountState.premium?.unlocked || this.historyState.reports.length > 0);
    if (this.historyButton) this.historyButton.hidden = !canRead;
    if (!canRead && this.view === 'reports') this.view = 'account';
    const reports = canRead && this.view === 'reports';
    if (this.dialog) this.dialog.dataset.signedIn = String(signedIn);
    if (this.navigation) this.navigation.hidden = !canRead;
    if (this.accountBody) {
      this.accountBody.hidden = reports;
      if (signedIn) {
        this.accountBody.setAttribute('role', 'tabpanel');
        this.accountBody.setAttribute('aria-labelledby', 'accountTabAccount');
        this.accountBody.tabIndex = 0;
      } else {
        this.accountBody.removeAttribute('role');
        this.accountBody.removeAttribute('aria-labelledby');
        this.accountBody.removeAttribute('tabindex');
      }
    }
    if (this.historySection) this.historySection.hidden = !reports;
    for (const tab of this.tabs || []) {
      const active = tab.dataset.accountTab === this.view;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    }
  }
  open(intent = null, opener = null) {
    if (!this.dialog) return;
    this.signInRevision++;
    this.google.suppress();
    this.intent = intent;
    this.setView(['reports', 'history'].includes(intent) ? 'reports' : 'account');
    if (!this.dialog.open) { this.onBeforeOpen?.(); this.overlay?.open({ opener }); }
    this.renderIdentity();
    this.renderHistory();
    if (!this.accountState.user && this.accountState.configured) this.renderGoogle();
    if (this.accountState.user) this.history.reload();
  }
  cancelSignIn() {
    this.cancelPortal();
    this.signInRevision++;
    this.google.cancel();
    this.intent = null;
    accountAccess.clearIntent();
  }
  close() { this.cancelSignIn(); this.overlay?.close(); }
  cancelPortal() {
    this.portalRequest = null;
    if (this.portalConfirmation) this.google.cancel();
    this.portalConfirmation = null;
    this.portalHelp?.replaceChildren();
    if (this.portalButton) this.portalButton.disabled = false;
  }
  async openPurchasePortal() {
    if (this.portalRequest || !this.accountState.user || !this.accountState.purchaseLinked || !this.dialog?.open) return;
    if (this.getIsBusy?.()) {
      this.message('Wait for the current recording or test to finish before opening purchase management.');
      return;
    }
    if (this.portalConfirmation) this.cancelPortal();
    const attempt = { owner: this.accountState.user.id, revision: this.signInRevision };
    this.portalRequest = attempt;
    const isCurrent = () => this.portalRequest === attempt && this.dialog?.open
      && this.view === 'account' && this.signInRevision === attempt.revision
      && this.accountState.user?.id === attempt.owner && !this.getIsBusy?.();
    this.portalButton.disabled = true;
    this.portalHelp.replaceChildren();
    this.message('Opening purchase management…');
    try {
      const result = await accountAccess.api('/portal', { method: 'POST', body: {} });
      if (!isCurrent()) return;
      const url = freemiusPortalUrl(result.url);
      if (!url) throw new Error('portal_unavailable');
      window.location.assign(url);
    } catch (error) {
      if (isCurrent()) this.renderPortalHelp(error);
    } finally {
      if (this.portalRequest === attempt) {
        this.portalRequest = null;
        this.portalButton.disabled = false;
      }
    }
  }
  renderPortalHelp(error, confirm = false) {
    this.showError(error);
    const message = element('p', 'account-error', this.status?.textContent || 'Purchase management could not be opened. Please retry.');
    message.setAttribute('role', 'alert');
    this.message();
    this.portalHelp.replaceChildren(message);
    if (confirm || ['portal_confirmation_required', 'portal_account_mismatch'].includes(error.code || error.message)) {
      this.portalHelp.append(button('Confirm with Google', () => this.confirmPortalAccount()));
    }
    const help = element('p', 'account-caption', 'Use the email address on your purchase receipt to sign in to Freemius. If you do not know its password, use the recovery option there. Your Google password is never needed in MicProbe or Freemius.');
    const links = element('div', 'account-links');
    links.append(link('Sign in to Freemius', FREEMIUS_PORTAL_LOGIN, { newTab: true }),
      link('Contact support', 'mailto:support@micprobe.com'));
    this.portalHelp.append(help, links);
  }
  async confirmPortalAccount() {
    if (this.getIsBusy?.()) return;
    const owner = this.accountState.user?.id, revision = this.signInRevision;
    if (!owner || !this.dialog?.open || this.view !== 'account') return;
    const container = element('div', 'account-google');
    this.portalHelp.replaceChildren(container);
    const attempt = { isCurrent: () => this.portalConfirmation === attempt && container.isConnected
      && this.dialog?.open && this.view === 'account' && this.signInRevision === revision
      && this.accountState.user?.id === owner && !this.getIsBusy?.() };
    this.portalConfirmation = attempt;
    const failed = error => {
      if (!attempt.isCurrent()) return;
      this.portalConfirmation = null;
      this.renderPortalHelp(error, true);
    };
    this.message('Confirm with the Google account shown above. This keeps your current sign-in preference.'
      + (this.google.useRedirect ? ' Google will return you to MicProbe in this tab. Download any recording you want to keep first; audio cannot survive the page reload.' : ''));
    try {
      await this.google.renderButton(container, { isCurrent: attempt.isCurrent, onError: failed,
        redirect: { confirming: true, snapshot: this.getSignInSnapshot },
        onCredential: async credential => {
          await accountAccess.api('/google/confirm', { method: 'POST', body: { credential } });
          if (!attempt.isCurrent()) return;
          this.portalConfirmation = null;
          await this.openPurchasePortal();
        } });
    } catch (error) { failed(error); }
  }
  openReport(entry) {
    if (this.getIsBusy?.()) {
      this.message('Wait for the current recording or test and its analysis to finish before opening a saved report.');
      return;
    }
    return this.run(() => this.history.open(entry, report => {
      if (this.getIsBusy?.()) throw new Error('workflow_busy');
      this.close(); this.onOpenReport(report);
    }));
  }
  syncBusyState() {
    const busy = !!this.getIsBusy?.();
    for (const open of this.list?.querySelectorAll('[data-open-report]') || []) {
      open.disabled = busy;
      open.title = busy ? 'Available when the current recording or test and its analysis finish.' : '';
    }
  }
  async run(action, success = '') {
    this.message('Working…');
    try { await action(); this.message(typeof success === 'function' ? success() : success); }
    catch (error) { this.showError(error); }
  }
  showError(error) {
      const messages = {
        account_sign_in_required: 'Sign in to attach your lifetime purchase to your account.',
        purchase_verification_pending: 'Your purchase is waiting for verification. Use Retry purchase verification; you do not need to buy again.',
        billing_temporarily_unavailable: this.accountState.premium?.pending
          ? 'Purchase verification is pending. Use Retry purchase verification; you do not need to buy again.'
          : 'Purchase verification is temporarily unavailable. Please retry when connected.',
        sign_in_required: 'Your session ended. Sign in again to continue; pending reports stay with your account.',
        sign_in_expired: 'This sign-in request expired. Try again to start a new sign-in.',
        invalid_identity: 'Google sign-in could not be verified. Try again and choose your account.',
        sign_in_cookies_required: 'The sign-in cookie is missing. Allow cookies for MicProbe, then try again.',
        google_temporarily_unavailable: 'Google sign-in is temporarily unavailable. Please try again shortly.',
        network_timeout: 'The connection took too long. Check your connection and try again.',
        network_unavailable: 'The connection was interrupted. Reconnect and try again.',
        sign_in_check_account: 'The sign-in response was interrupted. Check the account shown before continuing.',
        account_changed: 'The account changed in another tab. This view has been refreshed; please check the account before continuing.',
        portal_confirmation_required: 'For your account security, confirm your Google sign-in before opening purchase management.',
        portal_account_mismatch: 'Choose the same Google account shown in your MicProbe profile. Your account has not been switched.',
        portal_owner_mismatch: 'We could not verify the purchase owner. Check that your Google email matches the receipt, or use the receipt email to sign in to Freemius. Contact support if it has changed; you do not need to buy again.',
        portal_identity_unverified: 'Google could not confirm ownership of this email address for purchase management. Use Freemius sign-in or contact support.',
        portal_unavailable: 'Purchase management is temporarily unavailable. Please retry; you do not need to buy again.',
        purchase_not_linked: 'No purchase is linked to this Google account. If you already paid, use Link an earlier purchase with the license key from your receipt, or contact support. You do not need to buy again.',
        sign_in_storage_required: 'This browser could not preserve your return to MicProbe. Allow site storage and try again. Download any recording you want to keep first.',
        public_checkout_required: 'Checkout is available on the public MicProbe site. Your test results remain here.',
        history_sync_busy: 'A report is saving. Please try again in a moment.',
        license_already_linked: 'This purchase is linked to another MicProbe account. Sign out and use the Google account you originally linked, or contact support with your receipt. You do not need to buy again.',
        invalid_license: 'This purchase could not be verified. Check the key from your purchase email.',
        google_unavailable: 'Google sign-in could not load. Check your connection or browser settings, then retry.'
      };
      this.message(messages[error.message] || 'The request could not be completed. Your current test is preserved; please retry.');
  }
  renderIdentity() {
    if (!this.accountBody) return;
    this.cancelPortal();
    this.portalButton = null;
    this.accountBody.replaceChildren();
    const state = this.accountState;
    if (state.user) {
      this.rememberMe = false;
      const profile = element('div', 'account-profile');
      const initials = (state.user.name || state.user.email || '?').trim().split(/\s+/u).slice(0, 2).map(part => Array.from(part)[0]).join('').toUpperCase();
      const avatar = element('span', 'account-avatar', initials); avatar.setAttribute('aria-hidden', 'true');
      const identity = element('div', 'account-profile-info');
      identity.append(element('h3', '', state.user.name || 'Your account'), element('p', 'account-email', state.user.email),
        element('p', 'account-caption', 'Signed in with Google'));
      profile.append(avatar, identity); this.accountBody.append(profile);
      const plan = element('section', 'account-section');
      plan.append(element('h3', '', 'Plan'), element('p', 'account-entitlement', state.premium?.pending
        ? 'Purchase verification pending' : state.error ? 'Connection unavailable' : state.premium?.unlocked ? 'Lifetime Premium' : 'Free account'));
      plan.append(element('p', 'account-muted', state.premium?.pending
        ? 'Purchase verification pending. Your purchase is linked, but we could not confirm access yet. You do not need to buy again.'
        : state.error
        ? 'Your account connection could not be checked. Reconnect to confirm your purchase and sync reports.'
        : state.premium?.unlocked ? 'Unlimited microphone tests and detailed guidance. One payment, no renewal.'
          : 'Daily microphone tests. Premium includes unlimited tests, detailed guidance and a report archive.'));
      const actions = element('div', 'account-actions');
      if (state.premium?.pending) actions.append(button('Retry purchase verification', () => this.run(() => accountAccess.refresh({ sessionOnly: true }))));
      else if (state.error) actions.append(button('Retry account connection', () => this.run(() => accountAccess.refresh())));
      else if (!state.premium?.unlocked) actions.append(button('Get Lifetime Premium', () => this.run(() => this.onCheckout()), 'account-button account-button--primary'));
      if (state.purchaseLinked) {
        this.portalButton = button('Manage purchase', () => this.openPurchasePortal());
        actions.append(this.portalButton);
      }
      plan.append(actions); this.accountBody.append(plan);
      this.portalHelp = element('div', 'account-portal-help');
      plan.append(this.portalHelp);
      if (!state.error && !state.premium?.pending && !state.premium?.unlocked) this.renderPurchaseRestore({ container: plan });
      const privacy = element('section', 'account-section');
      privacy.append(element('h3', '', 'Privacy & support'), element('p', 'account-muted',
        'Saved reports contain measurements and notes. Your audio recordings stay on your device.'));
      const links = element('div', 'account-links');
      links.append(link('Privacy policy', '/privacy.html#sign-in', { newTab: true }), link('Contact support', 'mailto:support@micprobe.com'));
      const requests = element('details', 'account-data-help');
      requests.append(element('summary', '', 'Account data and deletion'), element('p', 'account-muted',
        'To request a copy of your account data or delete your account, email us. We verify your account before making changes.'),
      link('Email an account request', 'mailto:support@micprobe.com?subject=MicProbe%20account%20data%20request'));
      privacy.append(links, requests); this.accountBody.append(privacy);
      const session = element('div', 'account-section account-session');
      session.append(button('Sign out', () => this.run(() => accountAccess.logout(), 'Signed out. Your saved reports and purchases stay in your account.')),
        element('p', 'account-caption', 'Ends this browser session. Your saved reports and purchases stay in your account.'));
      this.accountBody.append(session);
    } else {
      this.accountBody.append(element('h3', '', this.intent === 'test-limit' ? 'Sign in for free to run more tests'
        : this.intent === 'checkout' ? 'Keep your lifetime purchase with you' : 'Keep your test reports together'));
      this.accountBody.append(element('p', 'account-muted', 'Sign in for more microphone tests and access to your purchase. Saving new reports requires Premium.'));
      if (state.error) this.accountBody.append(button('Retry account connection', () => this.run(() => accountAccess.refresh())));
      else if (!state.ready) this.accountBody.append(element('p', 'account-muted', 'Checking sign-in availability…'));
      else if (!state.configured) {
        this.accountBody.append(element('p', 'account-muted', 'Account sign-in is not available on this site yet. You can continue testing, but reports will not be saved to your account.'));
        this.renderPurchaseRestore({ legacy: true });
      }
      else {
        const rememberLabel = element('label', 'account-remember');
        const remember = element('input'); remember.type = 'checkbox'; remember.checked = this.rememberMe;
        remember.setAttribute('aria-describedby', 'accountRememberHint');
        remember.addEventListener('change', () => {
          this.rememberMe = remember.checked;
          if (this.google.useRedirect) { this.google.cancel(); this.renderGoogle(); }
        });
        rememberLabel.append(remember, element('span', '', 'Keep me signed in on this device'));
        const rememberHint = element('p', 'account-caption', 'Up to 30 days. Leave unchecked on a shared device.');
        rememberHint.id = 'accountRememberHint';
        this.accountBody.append(rememberLabel, rememberHint);
        this.googleContainer = element('div', 'account-google');
        this.googleHint = element('p', 'account-muted');
        this.googleHint.setAttribute('role', 'status');
        this.googleRetry = button('Try again', () => this.renderGoogle());
        this.googleRetry.hidden = true;
        this.accountBody.append(this.googleHint, this.googleContainer, this.googleRetry);
        if (this.dialog?.open) this.renderGoogle();
      }
      this.accountBody.append(element('p', 'account-caption account-signin-note', 'Only tests started while signed in are saved. Earlier guest results are not added. Audio stays on your device.'),
        link('Privacy policy', '/privacy.html#sign-in', { newTab: true }));
    }
  }
  renderPurchaseRestore({ legacy = false, container = this.accountBody } = {}) {
    const details = element('details', 'account-restore');
    details.append(element('summary', '', legacy ? 'Restore an earlier purchase' : 'Link an earlier purchase'));
    details.append(element('p', 'account-muted', legacy
      ? 'Use the full license key from your purchase email to restore Premium on this browser.'
      : 'Already paid? Link the license key from your purchase email. If you previously linked it, sign in with that Google account. You do not need to buy again.'));
    const form = element('form', 'account-actions');
    const label = element('label', 'account-field', 'License key from your purchase email');
    const input = element('input'); input.type = 'password'; input.required = true; input.autocomplete = 'off'; input.maxLength = 256;
    label.append(input);
    const submit = button(legacy ? 'Restore purchase' : 'Link purchase', () => {}); submit.type = 'submit';
    form.append(label, submit);
    form.addEventListener('submit', event => {
      event.preventDefault();
      this.run(async () => {
        if (legacy) await this.onRestoreLegacyPurchase(input.value.trim());
        else await accountAccess.restorePurchase(input.value.trim());
        input.value = '';
      }, legacy ? 'Premium access restored on this browser.' : 'Your purchase is linked to this account.');
    });
    details.append(form, element('p', 'account-caption', 'Cannot find the email or access the original account? Contact support with your purchase email address or receipt. Never send your Google password.'),
      link('Contact support', 'mailto:support@micprobe.com?subject=MicProbe%20purchase%20recovery'));
    container.append(details);
  }
  async renderGoogle() {
    const container = this.googleContainer;
    if (!container || !this.dialog?.open || this.googleLoading) return;
    const hint = this.googleHint, retry = this.googleRetry;
    const rememberMe = this.rememberMe;
    const isCurrent = () => container === this.googleContainer && container.isConnected
      && this.dialog?.open && !this.accountState.user && !this.getIsBusy?.()
      && (!this.google.useRedirect || rememberMe === this.rememberMe);
    const recover = error => {
      if (!isCurrent()) return;
      container.replaceChildren();
      if (hint) hint.textContent = '';
      if (retry) retry.hidden = false;
      this.showError(error);
    };
    this.googleLoading = true;
    if (hint) hint.textContent = 'Preparing Google sign-in…';
    if (retry) retry.hidden = true;
    this.message('');
    try {
      await this.google.renderButton(container, {
        isCurrent,
        onError: recover,
        redirect: { rememberMe, snapshot: this.getSignInSnapshot },
        onCredential: async credential => {
          const intent = this.intent;
          const revision = this.signInRevision;
          container.replaceChildren();
          if (hint) hint.textContent = 'Signing in…';
          try {
            await accountAccess.signInWithGoogle(credential, { rememberMe: this.rememberMe });
            // Closing/reopening the dialog cancels navigation, even if the
            // server has already committed the sign-in while its reply was pending.
            if (revision !== this.signInRevision || !this.dialog?.open) return;
            accountAccess.clearIntent();
            this.intent = null;
            if (intent === 'checkout') await this.onCheckout();
            this.message('Signed in. Your account is ready.');
          } catch (error) {
            if (revision !== this.signInRevision || !this.dialog?.open) return;
            if (!isCurrent()) this.showError(error);
            else throw error;
          }
        }
      });
      if (isCurrent() && hint) hint.textContent = this.google.useRedirect
        ? 'Google will return you to MicProbe in this tab. Your report will be kept here. Download any recording you want to keep before continuing; audio cannot survive the page reload.' : '';
    } catch (error) { recover(error); }
    finally {
      this.googleLoading = false;
      // Replacing the signed-out view while Google loads must not leave its
      // new button empty. Same-container calls share this request and nonce.
      if (this.dialog?.open && !this.accountState.user && (this.googleContainer !== container
          || (this.google.useRedirect && this.rememberMe !== rememberMe))) this.renderGoogle();
    }
  }
  renderHistory() {
    if (!this.list || !this.actions) return;
    const state = this.historyState;
    const visible = !!this.accountState.user && state.userId === this.accountState.user.id;
    this.syncView();
    if (!visible) {
      this.actions.replaceChildren();
      this.list.replaceChildren();
      return;
    }
    this.actions.replaceChildren();
    const hasReports = state.reports.length > 0;
    if (hasReports) this.actions.append(element('p', 'account-muted', 'Each saved report keeps its own result. Audio recordings stay on your device.'));
    if (state.pendingCount) this.actions.append(element('p', 'account-muted', 'Items marked Waiting to sync are kept on this browser until saved to your account.'));
    const buttons = element('div', 'account-actions account-report-tools');
    if (hasReports || state.error || state.pendingCount) buttons.append(button(state.pendingCount ? `Retry sync (${state.pendingCount})` : state.error ? 'Try again' : 'Refresh reports', () => this.run(async () => { await this.history.retry(); await this.history.reload(); })));
    if (buttons.childElementCount) this.actions.append(buttons);
    if (state.error) this.actions.append(element('p', 'account-error', state.error));
    this.list.replaceChildren();
    if (!hasReports && (state.loading || !state.error)) {
      const empty = element('li', 'account-empty');
      empty.append(element('h4', '', state.loading ? 'Loading your reports…' : 'No saved reports yet'));
      if (!state.loading) empty.append(element('p', 'account-muted', 'Premium saves each test result independently. Your previous results never affect a new assessment.'), button('Back to test', () => this.close()));
      this.list.append(empty);
    }
    for (const entry of state.reports) {
      const card = element('li', 'account-report');
      const row = element('div', 'account-report-heading');
      const title = element('div');
      title.append(element('h4', '', entry.report.profile?.label || entry.report.profile?.id || 'Microphone report'),
        element('p', 'account-caption', testDate(entry)), element('p', 'account-caption', entry.report.device?.micName || 'Microphone unknown'));
      row.append(title);
      card.append(row);
      const summary = entry.report.result?.summary || entry.evaluation?.public?.summary
        || (entry.pending ? 'Waiting to save this result.' : 'Previously saved report. Open to view its recorded result.');
      if (summary) card.append(element('p', 'account-result', summary));
      const field = element('label', 'account-field', 'Personal note');
      // A refresh may replace cloud IDs; run identity and owner keep an unsaved
      // note stable without carrying it into a different account's editor.
      const draftKey = JSON.stringify([state.userId, entry.report.run.id]);
      const note = element('input'); note.type = 'text'; note.maxLength = 500;
      note.value = this.noteDrafts.get(draftKey) ?? entry.note ?? ''; note.placeholder = 'e.g. Desk microphone';
      note.addEventListener('input', () => this.noteDrafts.set(draftKey, note.value));
      field.append(note);
      if (entry.note) card.append(element('p', 'account-saved-note', entry.note));
      const editor = element('details', 'account-note');
      editor.open = this.noteDrafts.has(draftKey);
      editor.append(element('summary', '', entry.note ? 'Edit note' : 'Add note'), field);
      const actions = element('div', 'account-actions');
      const open = button('Open report', () => this.openReport(entry));
      open.dataset.openReport = '';
      open.classList.add('account-button--primary');
      editor.append(button('Save note', () => this.run(async () => {
          const draft = note.value;
          await this.history.updateNote(entry.id, draft);
          if (this.noteDrafts.get(draftKey) === draft) this.noteDrafts.delete(draftKey);
        }, () => {
          const current = this.history.getState();
          if (current.userId !== state.userId) return 'The account changed. Check your account before continuing.';
          const saved = current.reports.find(item => item.report.run.id === entry.report.run.id);
          return saved?.pending ? 'Note kept on this browser and waiting to sync. Use Retry sync when connected.' : 'Note saved.';
        })));
      const remove = button('Delete', () => {
          const warning = element('div', 'account-delete-confirm', 'Delete this report? This cannot be undone.');
          warning.setAttribute('role', 'group'); warning.setAttribute('aria-label', 'Confirm report deletion');
          const cancel = button('Keep', () => { warning.remove(); remove.focus(); });
          warning.append(button('Delete report', () => this.run(() => this.history.remove(entry.id)), 'account-button account-button--danger'), cancel);
          actions.querySelector('.account-delete-confirm')?.remove(); actions.append(warning);
          cancel.focus();
        });
      remove.classList.add('account-button--quiet');
      actions.append(open, remove);
      if (entry.pending) actions.append(element('span', 'account-muted', entry.saveError
        ? entry.saveError === 'report_storage_full' ? 'Not saved: saved report storage is full' : 'Could not save: unsupported report data' : 'Waiting to sync'));
      card.append(actions, editor); this.list.append(card);
    }
    if (state.nextCursor) {
      const more = element('li', 'account-load-more');
      more.append(button('Load older reports', () => this.history.reload({ more: true })));
      this.list.append(more);
    }
    this.syncBusyState();
  }
  destroy() { this.google.cancel(); this.unsubscribeAccount?.(); this.unsubscribeHistory?.(); this.unsubscribeIntent?.(); this.unsubscribePremium?.(); }
}
