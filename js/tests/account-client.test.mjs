import test from 'node:test';
import assert from 'node:assert/strict';
import accountAccess, { AccountAccess } from '../modules/AccountAccess.js';
import { ReportHistory } from '../modules/ReportHistory.js';
import AccountPanelUI, { comparisonRows } from '../ui/AccountPanelUI.js';
import { CheckoutStateSnapshot } from '../modules/CheckoutStateSnapshot.js';
import reportEvaluator from '../modules/ReportEvaluator.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const fixture = id => ({ version: '2.0', generatedAt: '2026-09-05T12:00:00.000Z', run: { id, type: 'test' },
  profile: { id: 'discord', label: 'Discord Voice', requestedConstraints: { sampleRate: 16000, noiseSuppression: true },
    appliedConstraints: { sampleRate: 48000, noiseSuppression: false } }, device: { micName: 'USB mic' } });
function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
function mockAccount() {
  const listeners = new Set();
  return { user: null, calls: [],
    subscribe(listener) { listeners.add(listener); listener({ user: this.user }); return () => listeners.delete(listener); },
    switchUser(id) { this.user = id ? { id } : null; listeners.forEach(listener => listener({ user: this.user })); },
    requireSignIn() { return !!this.user; },
    async api(path, options = {}) {
      this.calls.push({ path, options, userId: this.user?.id });
      if (options.method === 'POST') return { ok: true, report: { id: `saved-${options.body.report.run.id}`, ...options.body, createdAt: options.body.report.generatedAt } };
      return { ok: true, reports: [], nextCursor: null };
    }
  };
}

test('account snapshots survive repeated tests and opening a saved report does not recapture it', async () => {
  const account = mockAccount();
  const history = new ReportHistory({ account, storage: storage() });
  account.switchUser('A'); await tick();
  const report = fixture('first'); history.capture(report); report.profile.label = 'changed';
  history.capture(fixture('second')); await tick();
  assert.equal(history.getState().reports[1].report.profile.label, 'Discord Voice');
  const entry = history.getState().reports[1];
  history.open(entry, saved => history.capture(saved));
  assert.equal(history.getState().reports.length, 2);
});

test('signed-out tests do not retain reports in memory or browser storage', () => {
  const saved = storage();
  const account = mockAccount(); const history = new ReportHistory({ account, storage: saved });
  for (let index = 0; index < 30; index++) history.capture(fixture(`run-${index}`));
  assert.deepEqual(history.getState().reports, []);
  assert.equal(saved.getItem('micprobe:report-history:v1'), null);
  assert.deepEqual(account.calls, []);
});

test('legacy guest history is retired while account-owned pending reports survive', async () => {
  const saved = storage(); const account = mockAccount();
  saved.setItem('micprobe:report-history:v1', JSON.stringify({
    guest: [{ id: 'guest', report: fixture('guest'), note: '' }],
    pending: { A: [{ id: 'owned', report: fixture('owned'), note: '', pending: true, cloudSaveUnknown: false }] }
  }));
  const history = new ReportHistory({ account, storage: saved });
  history.capture(fixture('guest'));
  assert.deepEqual(history.getState().reports, []);
  assert.equal(Object.hasOwn(JSON.parse(saved.getItem('micprobe:report-history:v1')), 'guest'), false);
  account.switchUser('A'); await tick();
  assert.equal(account.calls.filter(call => call.options.method === 'POST').length, 0);
  assert.deepEqual(history.getState().reports.map(entry => entry.report.run.id), ['owned']);
  await history.retry();
  assert.equal(account.calls.filter(call => call.options.method === 'POST').length, 1);
  account.switchUser('B'); await tick();
  assert.deepEqual(history.getState().reports, []);
  assert.equal(account.calls.filter(call => call.options.method === 'POST').length, 1);
});

test('failed account writes remain pending only for the owning account and can be retried', async () => {
  const account = mockAccount(); const saved = storage();
  const history = new ReportHistory({ account, storage: saved });
  account.switchUser('A'); await tick();
  const original = account.api.bind(account);
  account.api = async (path, options) => { if (options?.method === 'POST') throw new Error('offline'); return original(path, options); };
  history.capture(fixture('private-A')); await tick();
  assert.equal(history.getState().pendingCount, 1);
  account.switchUser(null);
  assert.equal(history.getState().reports.length, 0);
  account.switchUser('B'); await tick();
  assert.equal(history.getState().reports.length, 0);
  account.switchUser('A'); await tick();
  assert.equal(history.getState().reports[0].report.run.id, 'private-A');
  account.api = original; await history.retry();
  assert.equal(history.getState().pendingCount, 0);
  assert.equal(history.getState().reports[0].id, 'saved-private-A');
});

test('late cloud history from a previous identity cannot populate the next account', async () => {
  const account = mockAccount(); let finish;
  account.api = async () => account.user.id === 'A' ? new Promise(resolve => { finish = resolve; }) : { ok: true, reports: [] };
  const history = new ReportHistory({ account, storage: storage() });
  account.switchUser('A'); account.switchUser('B'); await tick();
  finish({ ok: true, reports: [{ id: 'private', report: fixture('private') }] }); await tick();
  assert.deepEqual(history.getState().reports, []);
});

test('late save acknowledgment cannot remove or expose another identity pending reports', async () => {
  const account = mockAccount(); let finish;
  const original = account.api.bind(account);
  account.api = async (path, options) => options?.method === 'POST' ? new Promise(resolve => { finish = resolve; }) : original(path, options);
  const history = new ReportHistory({ account, storage: storage() });
  account.switchUser('A'); await tick(); history.capture(fixture('private'));
  account.switchUser('B'); await tick();
  finish({ ok: true, report: { id: 'cloud', report: fixture('private'), note: '' } }); await tick();
  assert.deepEqual(history.getState().reports, []);
  account.switchUser('A'); await tick(); assert.equal(history.getState().pendingCount, 1);
});

test('note updates use the saved report id while preserving the original report snapshot', async () => {
  const account = mockAccount(); const history = new ReportHistory({ account, storage: storage() });
  account.switchUser('A'); await tick(); history.capture(fixture('note')); await tick();
  const original = account.api.bind(account);
  account.api = async (path, options) => {
    if (options?.method === 'POST') { account.calls.push({ path, options }); return { ok: true, report: { id: 'saved-note', report: fixture('note'), note: '' } }; }
    if (options?.method === 'PATCH') { account.calls.push({ path, options }); return { ok: true, report: { id: 'saved-note', report: fixture('note'), note: options.body.note } }; }
    return original(path, options);
  };
  await history.updateNote('saved-note', 'Lowered gain');
  assert.equal(history.getState().reports[0].note, 'Lowered gain');
  assert.ok(account.calls.some(call => call.path === '/reports/saved-note' && call.options.method === 'PATCH'));
});

test('detailed comparison preserves unknown readings, measured zero, and requested versus applied settings', () => {
  const report = fixture('compare');
  report.audioMetrics = { status: 'measured', clipping: { status: 'measured', rate: 0 },
    noiseFloor: { status: 'unavailable', estimatedDb: -90 }, coverage: { truncated: true } };
  const rows = Object.fromEntries(comparisonRows(report, { detailed: true }));
  assert.equal(rows['Peak level'], 'Unknown');
  assert.equal(rows['Clipped samples'], '0 %');
  assert.equal(rows['Estimated noise floor'], 'Unknown');
  assert.equal(rows['Sample rate (requested)'], '16000 Hz');
  assert.equal(rows['Sample rate (applied)'], '48000 Hz');
  assert.equal(rows['Noise suppression (applied)'], 'Off');
  assert.equal(rows['Analyzed coverage'], 'Partial recording');
});

test('free comparison uses the existing short assessment without measurement or captured-setting rows', () => {
  const report = fixture('free-comparison');
  const free = reportEvaluator.evaluateFree(report);
  const rows = Object.fromEntries(comparisonRows(report));
  assert.deepEqual(Object.keys(rows), ['Profile', 'Result', 'Summary', 'Assessment']);
  assert.equal(rows.Result, free.overall.label);
  assert.equal(rows.Summary, free.summary);
  assert.equal(rows.Assessment, 'Insufficient audio');
  assert.doesNotMatch(JSON.stringify(rows), /16000|48000|USB mic|RMS|Peak|suppression/);
});

test('comparison DOM follows current Premium access, clears on owner change, and preserves note drafts', t => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  class DomNode {
    constructor() { this.children = []; this.text = ''; this.scrolls = 0; }
    set textContent(value) { this.text = String(value); }
    get textContent() { return this.text + this.children.map(child => child.textContent).join(' '); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    hasChildNodes() { return this.children.length > 0; }
    scrollIntoView() { this.scrolls++; }
  }
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => new DomNode() } });
  t.after(() => {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else delete globalThis.document;
  });
  let unlocked = false;
  const panel = Object.assign(Object.create(AccountPanelUI.prototype), {
    premiumAccess: { isUnlocked: () => unlocked }, accountState: { user: { id: 'A' } },
    selected: new Set(['one', 'two']), noteDrafts: new Map([['draft', 'Unsaved note']]), compare: new DomNode(),
    historyState: { reports: ['one', 'two'].map(id => ({ id, report: fixture(id), note: `Note ${id}` })) }
  });
  panel.renderComparison();
  assert.match(panel.compare.textContent, /Saved report summaries/);
  assert.match(panel.compare.textContent, /Note one/);
  assert.doesNotMatch(panel.compare.textContent, /RMS level|16000 Hz|Use the same phrase/);
  unlocked = true;
  panel._syncComparisonAccess({ userId: 'A' });
  assert.match(panel.compare.textContent, /RMS level/);
  assert.match(panel.compare.textContent, /16000 Hz/);
  assert.match(panel.compare.textContent, /48000 Hz/);
  unlocked = false;
  panel._syncComparisonAccess({ userId: 'A' });
  assert.doesNotMatch(panel.compare.textContent, /RMS level|16000 Hz|Use the same phrase/);
  assert.match(panel.compare.textContent, /Note two/);
  assert.equal(panel.compare.scrolls, 1, 'Access refresh must not move the dialog');
  panel._syncComparisonAccess({ userId: 'B' });
  assert.equal(panel.compare.children.length, 0);
  assert.equal(panel.noteDrafts.get('draft'), 'Unsaved note');
  delete panel.premiumAccess;
  panel.renderComparison();
  assert.doesNotMatch(panel.compare.textContent, /RMS level|16000 Hz/);
});

test('Google credential exchange uses cookie transport and never includes an access token in state', async () => {
  const calls = [];
  const account = new AccountAccess({ request: async (path, options) => {
    calls.push({ path, options });
    return { ok: true, json: async () => path.split('?')[0].endsWith('/config') ? { ok: true, configured: true } : { ok: true, user: { id: 'A' }, premium: { unlocked: true } } };
  } });
  await account.signInWithGoogle('google-credential');
  const login = calls.find(call => call.path.endsWith('/google'));
  assert.equal(login.options.credentials, 'same-origin');
  assert.equal(login.options.headers['X-MicProbe-Request'], '1');
  assert.equal(JSON.parse(login.options.body).credential, 'google-credential');
  assert.equal(JSON.stringify(account.getState()).includes('google-credential'), false);
  await account.logout();
  assert.equal(account.getState().user, null);
  assert.equal(account.getState().premium.unlocked, false);
});

test('failed session validation never retains a previously granted premium state', async () => {
  const account = new AccountAccess({ request: async () => { throw new Error('offline'); } });
  account.state = { ready: true, configured: true, user: { id: 'A' }, premium: { unlocked: true }, error: '' };
  await account.refresh();
  assert.equal(account.getState().premium.unlocked, false);
  assert.equal(account.getState().error, 'offline');
});

test('logout invalidates a pending session refresh so a late response cannot sign the user back in', async () => {
  let finish;
  const account = new AccountAccess({ request: async path => ({ ok: true, json: async () => {
    if (path.endsWith('/session')) return new Promise(resolve => { finish = resolve; });
    return { ok: true, configured: true };
  } }) });
  const refresh = account.refresh(); await tick(); await account.logout();
  finish({ ok: true, user: { id: 'A' }, premium: { unlocked: true } }); await refresh;
  assert.equal(account.getState().user, null);
  assert.equal(account.getState().premium.unlocked, false);
});

test('a stale history refresh cannot discard a new report saved while it was loading', async () => {
  const account = mockAccount(); const history = new ReportHistory({ account, storage: storage() });
  account.switchUser('A'); await tick();
  const original = account.api.bind(account); let finish;
  account.api = async (path, options) => options?.method === 'POST' ? original(path, options) : new Promise(resolve => { finish = resolve; });
  const reload = history.reload(); history.capture(fixture('new')); await tick();
  assert.equal(history.getState().pendingCount, 0);
  finish({ ok: true, reports: [] }); await reload;
  assert.equal(history.getState().reports[0].report.run.id, 'new');
});

test('replacing the sign-in container during loading renders one current Google nonce', async () => {
  const originalConfig = accountAccess.getSignInConfig;
  const originalGoogle = globalThis.google;
  const rendered = []; const initialized = []; let finish;
  let calls = 0;
  accountAccess.getSignInConfig = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  globalThis.google = { accounts: { id: {
    initialize: options => initialized.push(options.nonce), renderButton: target => rendered.push(target)
  } } };
  try {
    const first = { isConnected: true, replaceChildren() {} };
    const second = { isConnected: true, replaceChildren() {} };
    const panel = Object.assign(Object.create(AccountPanelUI.prototype), {
      googleContainer: first, dialog: { open: true }, accountState: { user: null }, message() {}
    });
    const loading = panel.renderGoogle();
    await panel.renderGoogle(); assert.equal(calls, 1);
    panel.googleContainer = second; await panel.renderGoogle(); assert.equal(calls, 1);
    finish({ configured: true, googleClientId: 'client', nonce: 'stale' }); await loading;
    assert.equal(calls, 2);
    finish({ configured: true, googleClientId: 'client', nonce: 'current' }); await tick();
    assert.deepEqual(initialized, ['current']); assert.deepEqual(rendered, [second]);
  } finally { accountAccess.getSignInConfig = originalConfig; globalThis.google = originalGoogle; }
});

test('a report completing after an account switch stays pending for its captured owner', async () => {
  const account = mockAccount(); const history = new ReportHistory({ account, storage: storage() });
  account.switchUser('A'); await tick();
  const report = fixture('in-flight-A'); report.run.accountOwnerId = 'A';
  account.switchUser('B'); await tick(); history.capture(report); await tick();
  assert.equal(history.getState().reports.length, 0);
  assert.equal(account.calls.filter(call => call.options.method === 'POST').length, 0);
  account.switchUser('A'); await tick(); assert.equal(history.getState().pendingCount, 1);
  await history.retry(); assert.equal(account.calls.find(call => call.options.method === 'POST').userId, 'A');
});

test('a guest recording that completes after sign-in is not retained or uploaded', async () => {
  const saved = storage(); const account = mockAccount(); const history = new ReportHistory({ account, storage: saved });
  const report = fixture('guest-in-flight'); report.run.accountOwnerId = null;
  account.switchUser('A'); await tick(); history.capture(report); await tick();
  assert.equal(saved.getItem('micprobe:report-history:v1'), null);
  assert.equal(history.getState().reports.length, 0);
  assert.equal(account.calls.filter(call => call.options.method === 'POST').length, 0);
});

test('checkout snapshots remain unconsumed for the wrong account and restore only once for their owner', () => {
  const snapshot = new CheckoutStateSnapshot({ storage: storage() });
  snapshot.save({ report: fixture('checkout-A'), ownerId: 'A', profileId: 'discord' });
  assert.equal(snapshot.consume({ ownerId: 'B' }), null);
  assert.equal(snapshot.consume({ ownerId: null }), null);
  assert.equal(snapshot.peek().report.run.id, 'checkout-A');
  assert.equal(snapshot.consume({ ownerId: 'A' }).report.run.id, 'checkout-A');
  assert.equal(snapshot.peek(), null);
});

test('account mismatch refreshes identity without replaying the previous account report payload', async () => {
  const calls = [];
  const account = new AccountAccess({ request: async (path, options) => {
    calls.push({ path, options });
    if (path.endsWith('/reports')) return { ok: false, json: async () => ({ ok: false, error: 'account_changed' }) };
    return { ok: true, json: async () => ({ ok: true, user: { id: 'B' }, premium: { unlocked: false } }) };
  } });
  account.state = { ready: true, configured: true, user: { id: 'A' }, premium: { unlocked: true } };
  await assert.rejects(account.api('/reports', { method: 'POST', body: { report: fixture('A') } }), /account_changed/);
  assert.equal(calls[0].options.headers['X-MicProbe-Account'], 'A');
  assert.equal(calls.filter(call => call.path.endsWith('/reports')).length, 1);
  assert.equal(calls.filter(call => call.path.endsWith('/config')).length, 0, 'Identity refresh must not rotate an active Google nonce');
  assert.equal(account.getState().user.id, 'B');
});

test('expired protected requests clear identity and preserve owner pending writes without replay', async () => {
  let posts = 0;
  const account = new AccountAccess({ request: async (path, options) => {
    if (path.endsWith('/reports') && options.method === 'POST') {
      posts++;
      return { ok: false, status: 401, json: async () => ({ ok: false, error: 'sign_in_required' }) };
    }
    return { ok: true, json: async () => ({ ok: true, user: null, premium: { unlocked: false }, reports: [] }) };
  } });
  account.state = { ready: true, configured: true, user: { id: 'A' }, premium: { unlocked: true }, error: '' };
  const history = new ReportHistory({ account, storage: storage() });
  await tick(); history.capture(fixture('expired-A')); await tick();
  assert.equal(account.getState().user, null);
  assert.equal(account.getState().premium.unlocked, false);
  assert.deepEqual(history.getState().reports, []);
  assert.equal(history.pending.A[0].report.run.id, 'expired-A');
  assert.equal(history.getState().loading, false);
  assert.equal(posts, 1);
});

test('confirmed session expiry still clears stale user if the follow-up session check is offline', async () => {
  const account = new AccountAccess({ request: async path => {
    if (path.endsWith('/session')) throw new Error('offline');
    return { ok: false, status: 401, json: async () => ({ ok: false, error: 'sign_in_required' }) };
  } });
  account.state = { ready: true, configured: true, user: { id: 'A' }, premium: { unlocked: true }, error: '' };
  await assert.rejects(account.api('/reports'), /sign_in_required/);
  assert.equal(account.getState().user, null);
  assert.equal(account.getState().error, 'offline');
});

test('shared rejected-access recovery closes an expired owner before an offline follow-up check', async () => {
  const requests = [];
  const account = new AccountAccess({ request: async path => { requests.push(path); throw new Error('offline'); } });
  account.state = { ready: true, configured: true, user: { id: 'A' }, premium: { unlocked: true }, error: '' };
  await account.refreshRejectedAccess('sign_in_required', 'A');
  assert.equal(account.getState().user, null);
  assert.equal(account.getState().premium.unlocked, false);
  assert.equal(account.getState().error, 'offline');
  assert.deepEqual(requests, ['/api/account/session']);
});

test('shared recovery preserves a newer owner and ignores unrelated request failures', async () => {
  const requests = [];
  const account = new AccountAccess({ request: async path => { requests.push(path); throw new Error('offline'); } });
  account.state = { ready: true, configured: true, user: { id: 'B' }, premium: { unlocked: true }, error: '' };
  await account.refreshRejectedAccess('invalid_report', 'B');
  assert.equal(account.getState().premium.unlocked, true);
  assert.deepEqual(requests, []);
  for (const code of ['sign_in_required', 'account_changed', 'premium_access_required']) {
    await account.refreshRejectedAccess(code, 'A');
    assert.equal(account.getState().user.id, 'B');
  }
  assert.deepEqual(requests, Array(3).fill('/api/account/session'));
});

test('late logout response cannot clear a newer account identity', async () => {
  let finish;
  const account = new AccountAccess({ request: () => new Promise(resolve => { finish = resolve; }) });
  account.state = { ready: true, configured: true, user: { id: 'A' }, premium: { unlocked: true } };
  const logout = account.logout();
  account.state = { ...account.state, user: { id: 'B' } };
  finish({ ok: true, json: async () => ({ ok: true }) });
  await assert.rejects(logout, /account_changed/);
  assert.equal(account.getState().user.id, 'B');
});

test('deleting a report already removed on another device clears the stale local row', async () => {
  const account = mockAccount(); const history = new ReportHistory({ account, storage: storage() });
  account.switchUser('A'); await tick(); history.capture(fixture('removed')); await tick();
  account.api = async () => { throw Object.assign(new Error('report_not_found'), { status: 404 }); };
  await history.remove('saved-removed');
  assert.deepEqual(history.getState().reports, []);
  assert.equal(history.getState().pendingCount, 0);
});

test('a failed cloud delete other than missing-report retains the report for retry', async () => {
  const account = mockAccount(); const history = new ReportHistory({ account, storage: storage() });
  account.switchUser('A'); await tick(); history.capture(fixture('retained')); await tick();
  account.api = async () => { throw Object.assign(new Error('account_unavailable'), { status: 503 }); };
  await assert.rejects(history.remove('saved-retained'), /account_unavailable/);
  assert.equal(history.getState().reports.length, 1);
});

test('pending purchase survives an offline session check and blocks another checkout', async () => {
  const requests = [];
  const account = new AccountAccess({ request: async path => { requests.push(path); throw new Error('offline'); } });
  account.state = { ready: true, configured: true, user: { id: 'A' }, premium: { unlocked: false, pending: true }, error: '' };
  await account.refresh({ sessionOnly: true });
  assert.equal(account.getState().premium.pending, true);
  await assert.rejects(account.startCheckout(), /purchase_verification_pending/);
  assert.deepEqual(requests, ['/api/account/session']);
});

test('first purchase or restore outage refreshes pending state without replaying the mutation', async () => {
  for (const path of ['/purchase', '/restore']) {
    const requests = [];
    const account = new AccountAccess({ request: async (url, options) => {
      requests.push({ url, method: options.method });
      if (url.endsWith('/session')) return { ok: true, json: async () => ({ ok: true, user: { id: 'A' }, premium: { unlocked: false, pending: true } }) };
      return { ok: false, status: 503, json: async () => ({ ok: false, error: 'billing_temporarily_unavailable' }) };
    } });
    account.state = { ready: true, configured: true, user: { id: 'A' }, premium: { unlocked: false }, error: '' };
    await assert.rejects(account.api(path, { method: 'POST', body: {} }), /billing_temporarily_unavailable/);
    assert.equal(account.getState().premium.pending, true);
    assert.deepEqual(requests, [{ url: `/api/account${path}`, method: 'POST' }, { url: '/api/account/session', method: 'GET' }]);
  }
});
