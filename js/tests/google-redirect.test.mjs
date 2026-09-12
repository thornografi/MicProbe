import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountService } from '../../server/account-service.mjs';
import { createNodeAccountDb } from '../../server/node-account-db.mjs';
import { googleRedirectRelay, GOOGLE_REDIRECT_PATH as path } from '../../server/google-redirect.mjs';
import { GoogleRedirectState, requiresGoogleRedirect } from '../modules/GoogleRedirectState.js';

const origin = 'https://micprobe.example';
function fixture(t) {
  const db = createNodeAccountDb(':memory:'); t.after(() => db.close());
  const service = createAccountService({ db, origin, googleClientId: 'client', verifyGoogleToken: JSON.parse });
  const send = (suffix, body, cookie = '', owner) => service.handle(new Request(`${origin}/api/account${suffix}`, {
    method: body ? 'POST' : 'GET', headers: { Cookie: cookie, Origin: origin,
      'Content-Type': 'application/json', 'X-MicProbe-Request': '1', ...(owner ? { 'X-MicProbe-Account': owner } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  }));
  const start = async (body = {}, cookie, owner) => {
    const response = await send('/google/redirect/start', body, cookie, owner);
    assert.equal(response.status, 200, await response.clone().text());
    return { ...await response.json(), cookie: response.headers.getSetCookie()[0].split(';')[0] };
  };
  const credential = (nonce, sub = 'alice') => JSON.stringify({ nonce, sub, aud: 'client',
    iss: 'https://accounts.google.com', email: `${sub}@gmail.com`, email_verified: true,
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 });
  const finish = (flow, cookie = flow.cookie, sub = 'alice', extra = {}) => send('/google/redirect/finish', {
    credential: credential(flow.nonce, sub), ...extra
  }, cookie);
  return { db, send, start, finish, credential };
}

for (const rememberMe of [false, true]) test(`redirect sign-in preserves rememberMe=${rememberMe} without granting Premium`, async t => {
  const f = fixture(t), flow = await f.start({ rememberMe });
  assert.equal(flow.loginUri, origin + path);
  const response = await f.finish(flow, flow.cookie, 'alice', { rememberMe: !rememberMe });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.premium.unlocked, false);
  assert.deepEqual(result.redirect, { nonce: flow.nonce, mode: 'signin' });
  const session = response.headers.getSetCookie().find(value => value.startsWith('micprobe_session='));
  assert.equal(session.includes('Max-Age=2592000'), rememberMe, 'Return payload cannot override the server-bound preference');
  assert.match(session, /HttpOnly; SameSite=Lax/);
  assert.equal((await f.finish(flow)).status, 401, 'A credential is exchanged once');
});

test('redirect confirmation keeps the original session, refuses another Google identity and account changes', async t => {
  const f = fixture(t), login = await f.finish(await f.start());
  const user = (await login.json()).user, session = login.headers.getSetCookie()[0].split(';')[0];
  const rows = await f.db.prepare('SELECT * FROM account_sessions').all();
  const flow = await f.start({ confirming: true }, session, user.id);
  const response = await f.finish(flow, `${session}; ${flow.cookie}`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).redirect.mode, 'confirm');
  assert.deepEqual(await f.db.prepare('SELECT * FROM account_sessions').all(), rows);
  assert.ok(response.headers.getSetCookie().every(value => !value.startsWith('micprobe_session=')));
  const wrong = await f.start({ confirming: true }, session, user.id);
  assert.equal((await (await f.finish(wrong, `${session}; ${wrong.cookie}`, 'bob')).json()).error, 'portal_account_mismatch');
  for (const changed of ['', `micprobe_session=${'a'.repeat(43)}`]) {
    const stale = await f.start({ confirming: true }, session, user.id);
    assert.equal((await (await f.finish(stale, `${changed}; ${stale.cookie}`)).json()).error, 'account_changed');
  }
  const expired = await f.start({ confirming: true }, session, user.id);
  await f.db.prepare('DELETE FROM account_sessions').run();
  assert.equal((await (await f.finish(expired, `${session}; ${expired.cookie}`)).json()).error, 'account_changed');
});

test('redirect proof requires its browser cookie, cannot bypass the flow and rejects another-tab sign-in', async t => {
  const f = fixture(t), flow = await f.start();
  assert.equal((await (await f.finish(flow, '')).json()).error, 'sign_in_cookies_required');
  const bypass = await f.send('/google', { credential: f.credential(flow.nonce), rememberMe: true }, flow.cookie);
  assert.equal(bypass.status, 401);
  const pending = await f.start(), other = await f.finish(await f.start());
  const session = other.headers.getSetCookie()[0].split(';')[0];
  assert.equal((await (await f.finish(pending, `${session}; ${pending.cookie}`)).json()).error, 'account_changed');
  assert.equal((await f.send('/google/redirect/start', { confirming: true })).status, 401);
});

for (const selected of ['alice', 'bob']) test(`mobile switch to ${selected} keeps the old session until verification`, async t => {
  const f = fixture(t), login = await f.finish(await f.start()), original = (await login.json()).user;
  const session = login.headers.getSetCookie().find(value => value.startsWith('micprobe_session=')).split(';')[0];
  const before = await f.db.prepare('SELECT * FROM account_sessions').all();
  const flow = await f.start({ switching: true, rememberMe: true }, session, original.id);
  assert.deepEqual(await f.db.prepare('SELECT * FROM account_sessions').all(), before);
  const response = await f.finish(flow, `${session}; ${flow.cookie}`, selected);
  assert.equal(response.status, 200, await response.clone().text());
  const result = await response.json();
  assert.equal(result.redirect.mode, 'switch');
  assert.equal(result.user.id === original.id, selected === 'alice');
  assert.equal(response.headers.getSetCookie().some(value => value.startsWith('micprobe_session=')), selected !== 'alice');
});

test('a stale mobile switch cannot replace an account selected in another tab', async t => {
  const f = fixture(t), login = await f.finish(await f.start()), original = (await login.json()).user;
  const session = login.headers.getSetCookie()[0].split(';')[0];
  const flow = await f.start({ switching: true }, session, original.id);
  const other = await f.finish(await f.start(), undefined, 'carol');
  const otherSession = other.headers.getSetCookie()[0].split(';')[0];
  assert.equal((await f.finish(flow, `${otherSession}; ${flow.cookie}`, 'bob')).status, 409);
  assert.equal((await (await f.send('/session', undefined, otherSession)).json()).user.email, 'carol@gmail.com');
});

test('mobile switch return accepts the new identity without transferring the old report', () => {
  let saved;
  const location = { hash: '', pathname: '/app', search: '' };
  const returns = new GoogleRedirectState({ storage: () => ({ setItem: (_, value) => { saved = value; },
    getItem: () => saved, removeItem: () => { saved = null; } }), location: () => location,
    history: () => ({ replaceState() {} }), now: () => 1000 });
  const snapshot = { report: { run: { id: 'alice-report' } } };
  for (const owner of ['alice', 'bob']) {
    returns.save({ nonce: 'nonce', mode: 'switch', owner: 'alice', snapshot, intent: 'switch' });
    location.hash = `#google_return=nonce&owner=${owner}&mode=switch`;
    assert.deepEqual(returns.take({ ready: true, user: { id: owner } }), {
      mode: 'switch', intent: 'switch', snapshot: owner === 'alice' ? snapshot : null
    });
  }
  returns.save({ nonce: 'nonce', mode: 'switch', owner: 'alice', snapshot, intent: 'switch' });
  location.hash = '#google_error=sign_in_expired';
  assert.deepEqual(returns.take({ ready: true, user: { id: 'alice' } }), { error: 'sign_in_expired', snapshot });
});

test('Back from Google restores only the same owner and never interrupts the original document', () => {
  let saved;
  const location = { hash: '#switch-account', pathname: '/app', search: '' };
  const options = { storage: () => ({ setItem: (_, value) => { saved = value; }, getItem: () => saved,
    removeItem: () => { saved = null; } }), location: () => location,
    history: () => ({ replaceState() {} }), now: () => 1000 };
  const original = new GoogleRedirectState(options), snapshot = { report: { run: { id: 'a-report' } } };
  original.save({ nonce: 'nonce', mode: 'switch', owner: 'a', snapshot, intent: 'switch' });
  const state = { ready: true, user: { id: 'a' } };
  assert.equal(original.take(state), null, 'Focus/visibility refresh keeps the active Google chooser');
  assert.deepEqual(new GoogleRedirectState(options).take(state), { mode: 'switch', snapshot, intent: 'account' });
  original.save({ nonce: 'nonce', mode: 'switch', owner: 'a', snapshot, intent: 'switch' });
  assert.deepEqual(new GoogleRedirectState(options).take({ ...state, user: { id: 'b' } }), { error: 'sign_in_check_account' });
});

test('cross-site callback requires double-submit CSRF, bounds the body and escapes the credential', async () => {
  const callback = (body, cookie = 'g_csrf_token=proof', contentType = 'application/x-www-form-urlencoded') => googleRedirectRelay(new Request(origin + path, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': contentType }, body
  }));
  const form = new URLSearchParams({ g_csrf_token: 'proof', credential: '"><script>credential</script>' });
  const response = await callback(form.toString());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  assert.equal(response.headers.get('Location'), null);
  const html = await response.text();
  assert.ok(!html.includes('<script>credential'));
  assert.ok(html.includes('&quot;&gt;&lt;script&gt;credential'));
  for (const [body, cookie, type] of [
    [form.toString(), ''], [form.toString(), 'g_csrf_token=wrong'],
    [form.toString() + '&credential=other'], [form.toString() + '&g_csrf_token=other'],
    [form.toString(), 'g_csrf_token=proof; g_csrf_token=proof'],
    ['x'.repeat(32769)], [form.toString(), undefined, 'application/json']
  ]) assert.equal((await callback(body, cookie, type)).status, 400);
});

test('iOS detection includes iPad desktop mode and excludes ordinary desktop/Android', () => {
  for (const device of [{ userAgent: 'iPhone' }, { userAgent: 'iPad' }, { platform: 'MacIntel', maxTouchPoints: 5 }]) assert.equal(requiresGoogleRedirect(device), true);
  for (const device of [{ userAgent: 'Android' }, { platform: 'MacIntel', maxTouchPoints: 0 }, {}]) assert.equal(requiresGoogleRedirect(device), false);
});

test('return snapshot is tab-bound, one-use and cannot restore across identities or expired flows', () => {
  const values = new Map(); let cleaned = 0;
  const location = { hash: '', pathname: '/app', search: '' };
  const returns = new GoogleRedirectState({ storage: () => ({ setItem: (key, value) => values.set(key, value),
    getItem: key => values.get(key), removeItem: key => values.delete(key) }), location: () => location,
    history: () => ({ replaceState() { cleaned++; location.hash = ''; } }), now: () => 1000 });
  const state = { ready: true, user: { id: 'new-account' } }, snapshot = { report: { run: { id: 'guest' } } };
  const save = (owner, intent = 'account') => returns.save({ nonce: 'nonce', mode: 'signin', owner, snapshot, intent });
  const fragment = () => { location.hash = '#google_return=nonce&owner=new-account&mode=signin'; };
  save(null); fragment();
  assert.deepEqual(returns.take(state), { mode: 'signin', snapshot, intent: 'account' });
  assert.equal(returns.take(state), null); assert.equal(cleaned, 1);
  for (const intent of ['signin', 'reports', 'checkout', 'test-limit', 'report']) {
    save(null, intent); fragment();
    assert.deepEqual(returns.take(state), { mode: 'signin', snapshot, intent });
  }
  for (const owner of ['other-account', null]) {
    save(owner); fragment();
    if (!owner) location.hash = '#google_return=wrong&owner=new-account&mode=signin';
    assert.deepEqual(returns.take(state), { error: 'sign_in_check_account' });
  }
  assert.throws(() => new GoogleRedirectState({ storage: () => { throw Error(); } }).save({}), /sign_in_storage_required/);
});
