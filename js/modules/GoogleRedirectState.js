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
  }
  save({ nonce, mode, owner, snapshot }) {
    try {
      this.storage().setItem(KEY, JSON.stringify({ nonce, mode, owner: owner || null, snapshot, savedAt: this.now() }));
    } catch { throw new Error('sign_in_storage_required'); }
  }
  take(state) {
    if (!state.ready || state.error) return null;
    const hash = this.location()?.hash || '';
    if (!/^#google_(return|error)=/.test(hash)) return null;
    const params = new URLSearchParams(hash.slice(1));
    this.history().replaceState(this.history().state, '', `${this.location().pathname}${this.location().search}`);
    let saved;
    try { saved = JSON.parse(this.storage().getItem(KEY)); this.storage().removeItem(KEY); } catch { /* Recover without a report snapshot. */ }
    const age = this.now() - saved?.savedAt;
    const valid = saved && Number.isFinite(age) && age >= 0 && age < 600000;
    const error = params.get('google_error');
    if (error) return { error, snapshot: valid && saved.owner === (state.user?.id || null) ? saved.snapshot : null };
    if (!valid || params.get('google_return') !== saved.nonce || params.get('mode') !== saved.mode
        || !state.user || params.get('owner') !== state.user.id
        || (saved.owner && saved.owner !== state.user.id)) return { error: 'sign_in_check_account' };
    return { mode: saved.mode, snapshot: saved.snapshot };
  }
}
export default new GoogleRedirectState();
