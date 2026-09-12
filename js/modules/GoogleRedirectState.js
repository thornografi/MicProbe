import { accountIntent } from './AccountNavigation.js';
const KEY = 'micprobe:google-return:v1';
export function requiresGoogleRedirect(device = globalThis.navigator) {
  return /iPhone|iPad|iPod/.test(device?.userAgent || '')
    || (device?.platform === 'MacIntel' && device.maxTouchPoints > 1);
}

/** Same-tab return context only: no Google credentials, license keys or audio. */
export class GoogleRedirectState {
  constructor({ storage = () => globalThis.sessionStorage, location = () => globalThis.location,
    history = () => globalThis.history, now = Date.now } = {}) {
    Object.assign(this, { storage, location, history, now });
    this.pageId = globalThis.crypto.randomUUID();
  }
  save({ nonce, mode, owner, snapshot, intent }) {
    try {
      this.storage().setItem(KEY, JSON.stringify({ nonce, mode, owner: owner || null, snapshot, intent: accountIntent(intent),
        savedAt: this.now(), pageId: this.pageId }));
    } catch { throw new Error('sign_in_storage_required'); }
  }
  take(state) {
    if (!state.ready || state.error) return null;
    const hash = this.location()?.hash || '';
    const returned = /^#google_(return|error)=/.test(hash);
    if (!returned && hash !== '#switch-account') return null;
    let saved;
    try { saved = JSON.parse(this.storage().getItem(KEY)); } catch { /* Recover without a report snapshot. */ }
    // Back from Google's page may reload the app without a callback. A focus
    // refresh in the original document must not cancel its active chooser.
    if (!returned && (saved?.mode !== 'switch' || saved.pageId === this.pageId)) return null;
    const params = new URLSearchParams(hash.slice(1));
    this.history().replaceState(this.history().state, '', `${this.location().pathname}${this.location().search}`);
    try { this.storage().removeItem(KEY); } catch { /* Storage may have become unavailable. */ }
    const age = this.now() - saved?.savedAt;
    const valid = saved && Number.isFinite(age) && age >= 0 && age < 600000;
    if (!returned) return valid && saved.owner === state.user?.id
      ? { mode: 'switch', snapshot: saved.snapshot, intent: 'account' } : { error: 'sign_in_check_account' };
    const error = params.get('google_error');
    if (error) return { error, snapshot: valid && saved.owner === (state.user?.id || null) ? saved.snapshot : null };
    if (!valid || params.get('google_return') !== saved.nonce || params.get('mode') !== saved.mode
        || !state.user || params.get('owner') !== state.user.id
        || (saved.owner && saved.owner !== state.user.id && saved.mode !== 'switch')) return { error: 'sign_in_check_account' };
    // A verified switch may change identity, but the old owner's result must not follow it.
    return { mode: saved.mode, snapshot: saved.mode === 'switch' && saved.owner !== state.user.id ? null : saved.snapshot,
      intent: accountIntent(saved.intent) };
  }
}
export default new GoogleRedirectState();
