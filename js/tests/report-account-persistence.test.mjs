import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountService } from '../../server/account-service.mjs';
import { createNodeAccountDb } from '../../server/node-account-db.mjs';
import { evaluatePremiumReport } from '../../server/premium-report-evaluator.js';
import { createTroubleshootingContext } from '../modules/TroubleshootingContext.js';
import { ReportHistory } from '../modules/ReportHistory.js';
import AccountPanelUI from '../ui/AccountPanelUI.js';

function waitForHistory(history, predicate) {
  if (predicate(history.getState())) return Promise.resolve();
  return new Promise(resolve => {
    const off = history.subscribe(state => { if (predicate(state)) { off(); resolve(); } });
  });
}
const origin = 'https://micprobe.example';
function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
}
const report = (id, type = 'test') => ({
  version: '2.0', generatedAt: new Date().toISOString(), run: { id, type },
  communicationContext: { usage: 'voice-call' }, profile: { id: 'discord' },
  troubleshooting: createTroubleshootingContext({ input: { usage: 'voice-call', os: 'windows', symptom: 'no-input' } }),
  audioMetrics: null
});

async function fixture(t) {
  const db = createNodeAccountDb(':memory:');
  t.after(() => db.close());
  const service = createAccountService({ db, origin, googleClientId: 'fixture-client', verifyGoogleToken: async raw => JSON.parse(raw) });
  const configResponse = await service.handle(new Request(`${origin}/api/account/config`));
  const config = await configResponse.json();
  const nonceCookie = configResponse.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const login = await service.handle(new Request(`${origin}/api/account/google`, {
    method: 'POST', headers: { Origin: origin, Cookie: nonceCookie, 'X-MicProbe-Request': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential: JSON.stringify({ sub: 'report-owner', nonce: config.nonce,
      iss: 'https://accounts.google.com', aud: 'fixture-client', email: 'reports@example.com', email_verified: true,
      exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000) }) })
  }));
  assert.equal(login.status, 200, await login.clone().text());
  const signed = await login.json();
  const cookie = login.headers.getSetCookie().find(value => value.startsWith('micprobe_session=')).split(';')[0];
  const account = {
    calls: [],
    subscribe(listener) { listener({ user: signed.user }); return () => {}; },
    requireSignIn: () => true,
    async api(path, { method = 'GET', body } = {}) {
      this.calls.push({ path, method });
      const response = await service.handle(new Request(`${origin}/api/account${path}`, {
        method, headers: { Origin: origin, Cookie: cookie, 'X-MicProbe-Account': signed.user.id,
          'X-MicProbe-Request': '1', 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      }));
      const result = await response.json();
      if (!response.ok) throw Object.assign(new Error(result.error), { status: response.status });
      return result;
    }
  };
  return { account, saved: storage() };
}

test('test, record and guidance reports retain normalized problem context and recommendations through the real account API', async t => {
  const { account } = await fixture(t);
  for (const type of ['test', 'record', 'troubleshooting']) {
    const input = report(`roundtrip-${type}`, type);
    const expected = evaluatePremiumReport(input);
    assert(expected.recommendations.some(item => item.id === 'GUIDE_WINDOWS_INPUT'));
    input.troubleshooting = { ...input.troubleshooting, injected: 'not a supported context field' };
    const saved = await account.api('/reports', { method: 'POST', body: { report: input, note: 'Checked microphone permission' } });
    assert.equal(saved.report.report.run.type, type);
    const loaded = (await account.api('/reports')).reports.find(entry => entry.report.run.id === input.run.id);
    assert.equal(loaded.note, 'Checked microphone permission');
    assert.deepEqual(loaded.report.troubleshooting, createTroubleshootingContext({ input: input.troubleshooting }));
    assert.deepEqual(evaluatePremiumReport(loaded.report), expected);
  }
});

test('a permanently rejected local report survives reload, does not block other saves, and can be deleted without another POST', async t => {
  const { account, saved } = await fixture(t);
  const first = new ReportHistory({ account, storage: saved });
  await waitForHistory(first, state => !state.loading);
  first.capture(report('invalid', 'unsupported'));
  await waitForHistory(first, state => state.reports.some(entry => entry.saveError === 'invalid_report'));
  assert.equal(first.getState().pendingCount, 1);
  assert.equal(first.getState().reports[0].saveError, 'invalid_report');
  assert.match(first.getState().error, /unsupported data/);
  first.capture(report('valid'));
  await waitForHistory(first, state => state.reports.some(entry => entry.report.run.id === 'valid' && !entry.pending));
  assert.equal(first.getState().pendingCount, 1);
  assert.equal(account.calls.filter(call => call.method === 'POST').length, 2);
  first.destroy();
  const restored = new ReportHistory({ account, storage: saved });
  t.after(() => restored.destroy());
  await waitForHistory(restored, state => !state.loading);
  assert.equal(restored.getState().reports.find(entry => entry.id === 'invalid').saveError, 'invalid_report');
  await restored.remove('invalid');
  assert.equal(account.calls.filter(call => call.method === 'POST').length, 2);
  assert.equal(account.calls.filter(call => call.method === 'DELETE').length, 0);
  await restored.reload();
  assert.equal(restored.getState().pendingCount, 0);
  assert.deepEqual(restored.getState().reports.map(entry => entry.report.run.id), ['valid']);
});

test('a lost save response resolves and deletes the cloud row instead of dropping its browser copy', async t => {
  const { account, saved } = await fixture(t);
  const history = new ReportHistory({ account, storage: saved });
  t.after(() => history.destroy());
  await waitForHistory(history, state => !state.loading);
  const api = account.api.bind(account);
  let loseResponse = true;
  account.api = async (path, options) => {
    const response = await api(path, options);
    if (options?.method === 'POST' && loseResponse) { loseResponse = false; throw new Error('connection_lost'); }
    return response;
  };
  history.capture(report('lost-response'));
  await waitForHistory(history, state => !!state.error);
  assert.equal(history.getState().reports[0].cloudSaveUnknown, true);
  assert.equal((await api('/reports')).reports.length, 1);
  await history.remove('lost-response');
  await history.reload();
  assert.deepEqual(history.getState().reports, []);
  assert.equal(account.calls.filter(call => call.method === 'POST').length, 2);
  assert.equal(account.calls.filter(call => call.method === 'DELETE').length, 1);
});

test('delete serializes saving and stale history reads cannot resurrect the deleted report', async t => {
  const { account, saved } = await fixture(t);
  const history = new ReportHistory({ account, storage: saved });
  t.after(() => history.destroy());
  await waitForHistory(history, state => !state.loading);
  history.capture(report('delete-race'));
  await waitForHistory(history, state => state.reports.some(entry => !entry.pending));
  const entry = history.getState().reports[0];
  const api = account.api.bind(account);
  const stale = await api('/reports');
  let releaseLoad, releaseDelete;
  account.api = (path, options) => options?.method === 'DELETE'
    ? new Promise(resolve => { releaseDelete = () => api(path, options).then(resolve); })
    : !options ? new Promise(resolve => { releaseLoad = () => resolve(stale); }) : api(path, options);
  const loading = history.reload();
  const deleting = history.remove(entry.id);
  history.capture(report('next-report'));
  assert.equal(account.calls.filter(call => call.method === 'POST').length, 1, 'queued saves wait for deletion');
  await releaseDelete();
  await deleting;
  releaseLoad();
  await loading;
  assert.deepEqual(history.getState().reports.map(item => item.report.run.id), ['next-report']);
  assert.deepEqual((await api('/reports')).reports.map(item => item.report.run.id), ['next-report']);
});

test('history keyboard/programmatic activation checks live busy state before restoring a report', () => {
  let busy = true, closed = 0, restored = 0, message = '';
  const panel = Object.create(AccountPanelUI.prototype);
  Object.assign(panel, { getIsBusy: () => busy, close: () => { closed++; }, message: text => { message = text; },
    history: { open: () => { restored++; } } });
  panel.openReport({ report: report('history') });
  assert.equal(restored, 0);
  assert.equal(closed, 0);
  assert.match(message, /analysis to finish/);
  busy = false;
  panel.openReport({ report: report('history') });
  assert.equal(restored, 1);
  assert.equal(closed, 1);
});
