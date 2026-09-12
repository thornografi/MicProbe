import accountAccess from '../modules/AccountAccess.js';
import { accountAvatar } from './AccountAvatar.js';
import { accountHash } from '../modules/AccountNavigation.js';

/** Shared identity display; does not import the microphone app, Google SDK or report archive. */
export function initAccountHeader() {
  const buttons = [...document.querySelectorAll('[data-account-header]')];
  const premiumLink = document.getElementById('pricingPremiumCta');
  let renderedIdentity;
  const unsubscribe = accountAccess.subscribe(state => {
    const identity = JSON.stringify([state.ready, state.user]);
    const plan = state.error ? 'Connection unavailable' : state.premium?.unlocked ? 'Lifetime Premium' : 'Free account';
    for (const button of buttons) {
      const label = state.user ? 'Account' : state.ready ? 'Sign in' : 'Checking account…';
      button.setAttribute('aria-label', label);
      button.setAttribute('aria-busy', String(!state.ready));
      button.dataset.accountIntent = state.user ? 'account' : 'signin';
      if (state.user) button.setAttribute('aria-description', `${state.user.name || ''} ${state.user.email || ''}. ${plan}`);
      else button.removeAttribute('aria-description');
      if (identity === renderedIdentity) continue;
      button.replaceChildren();
      if (state.user) button.append(accountAvatar(state.user));
      const text = document.createElement('span');
      text.className = 'account-header-label';
      text.textContent = state.user ? (state.user.name?.trim().split(/\s+/u)[0] || 'Account') : label;
      button.append(text);
    }
    renderedIdentity = identity;
    if (premiumLink) {
      const intent = state.error ? 'account' : state.user && state.premium?.unlocked ? 'reports'
        : state.user && (state.purchaseLinked || state.premium?.pending) ? 'account' : 'checkout';
      premiumLink.dataset.accountIntent = intent;
      premiumLink.href = `/app${accountHash(intent)}`;
      premiumLink.textContent = intent === 'reports' ? 'Open saved reports' : intent === 'account' ? 'Review your account' : 'Get Lifetime Premium';
    }
  });
  const refresh = () => {
    const state = accountAccess.getState();
    if (document.visibilityState === 'visible' && state.ready && state.configured) accountAccess.refresh({ sessionOnly: true });
  };
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', refresh);
  accountAccess.bootstrap();
  return () => { unsubscribe(); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
}
