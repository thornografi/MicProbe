import test from 'node:test';
import assert from 'node:assert/strict';
import { GoogleSignIn } from '../modules/GoogleSignIn.js';

function fixture(t, overrides = {}) {
  const values = new Map(), calls = [], credentials = [], errors = [];
  const state = { allowed: true, now: 1000 };
  const gsi = { initialize: options => calls.push({ kind: 'init', options }),
    prompt: () => calls.push({ kind: 'prompt' }), cancel: () => calls.push({ kind: 'cancel' }),
    renderButton: (container, options) => calls.push({ kind: 'button', container, options }) };
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const config = { configured: true, googleClientId: 'fixture-client', nonce: 'fixture-nonce' };
  const signin = new GoogleSignIn({ account: { getSignInConfig: async () => config },
    load: async () => gsi, canPrompt: () => state.allowed, now: () => state.now,
    storage: () => storage, onPromptCredential: value => credentials.push(value),
    onPromptError: error => errors.push(error.message), ...overrides });
  t.after(() => signin.cancel());
  return { signin, calls, credentials, errors, state, gsi, storage, config,
    callback: () => calls.findLast(call => call.kind === 'init').options.callback,
    count: kind => calls.filter(call => call.kind === kind).length };
}
const target = () => ({ clientWidth: 260, replaceChildren() {} });

test('iOS uses a server-bound redirect for buttons and suppresses optional popup prompts', async t => {
  const originalLocation = globalThis.location;
  globalThis.location = { origin: 'https://micprobe.example' };
  t.after(() => { if (originalLocation) globalThis.location = originalLocation; else delete globalThis.location; });
  const saved = [], starts = [];
  const f = fixture(t, { useRedirect: true, account: {
    api: async (path, options) => { starts.push({ path, ...options }); return { configured: true,
      googleClientId: 'client', nonce: 'nonce', loginUri: 'https://micprobe.example/api/account/google/redirect' }; },
    getState: () => ({ user: { id: 'owner' } })
  }, redirectState: { save: data => saved.push(data) } });
  await f.signin.offer(); assert.equal(f.count('prompt'), 0);
  await f.signin.renderButton(target(), { isCurrent: () => true, redirect: { confirming: true, rememberMe: true }, onCredential() {} });
  assert.equal(f.calls.findLast(call => call.kind === 'init').options.ux_mode, 'redirect');
  assert.deepEqual(starts[0].body, { confirming: true, switching: false, rememberMe: true });
  assert.deepEqual(saved[0], { nonce: 'nonce', mode: 'confirm', owner: 'owner', snapshot: undefined, intent: undefined });
});

test('button follows its container width without replacing the sign-in challenge', async t => {
  let resized, disconnected = 0;
  const previous = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(callback) { resized = callback; }
    observe() {}
    disconnect() { disconnected++; }
  };
  t.after(() => { if (previous) globalThis.ResizeObserver = previous; else delete globalThis.ResizeObserver; });
  const f = fixture(t), container = target();
  let complete;
  await f.signin.renderButton(container, { isCurrent: () => f.state.allowed,
    onCredential: () => new Promise(resolve => { complete = resolve; }) });
  const callback = f.callback();
  for (const width of [244, 244, 400, 0, 230]) { container.clientWidth = width; resized(); }
  assert.deepEqual(f.calls.filter(call => call.kind === 'button').map(call => call.options.width), [260, 244, 260, 230]);
  assert.equal(f.count('init'), 1);
  const pending = callback({ credential: 'selected' });
  container.clientWidth = 260; resized();
  assert.equal(f.count('button'), 4, 'resizing during sign-in must not restore the button');
  complete(); await pending;
  assert.equal(disconnected, 1);
  resized(); assert.equal(f.count('button'), 4, 'retired resize callbacks must be harmless');
});

test('One Tap requires explicit selection and consumes a credential only once', async t => {
  const f = fixture(t);
  await f.signin.offer();
  const options = f.calls.find(call => call.kind === 'init').options;
  assert.equal(options.auto_select, false);
  assert.equal(options.button_auto_select, false);
  assert.equal(options.itp_support, false);
  assert.equal(options.use_fedcm_for_button, true);
  assert.equal(options.nonce, 'fixture-nonce');
  assert.equal(Object.hasOwn(options, 'use_fedcm_for_prompt'), false);
  assert.equal(f.count('prompt'), 1);
  const callback = f.callback();
  await Promise.all([callback({ credential: 'chosen' }), callback({ credential: 'chosen' })]);
  assert.deepEqual(f.credentials, ['chosen']);
  await f.signin.offer(); assert.equal(f.count('prompt'), 1);
});

test('ineligible surfaces do not load Google or mint a challenge', async t => {
  const f = fixture(t, { load: () => { throw new Error('must not load'); },
    account: { getSignInConfig: () => { throw new Error('must not mint'); } } });
  f.state.allowed = false;
  await f.signin.offer();
  assert.equal(f.signin.offered, false);
});

test('suppression survives a reload in the same tab even without display notifications', async t => {
  const f = fixture(t);
  await f.signin.offer(); f.signin.cancel();
  const next = fixture(t, { storage: () => f.storage });
  await next.signin.offer();
  assert.equal(next.count('init'), 0);
});

test('a denied storage API still allows one optional attempt and a manual button', async t => {
  const f = fixture(t, { storage: () => { throw new Error('denied'); } });
  await f.signin.offer(); await f.signin.offer();
  assert.equal(f.count('prompt'), 1);
  await f.signin.renderButton(target(), { isCurrent: () => true, onCredential: () => {} });
  assert.equal(f.count('button'), 1);
});

test('starting a test or leaving the app while Google loads cancels the pending suggestion', async t => {
  let finish;
  const f = fixture(t, { load: () => new Promise(resolve => { finish = resolve; }) });
  const loading = f.signin.offer();
  f.state.allowed = false; f.signin.suppress();
  finish(f.gsi); await loading;
  assert.equal(f.count('init'), 0);
  f.state.allowed = true; await f.signin.offer(); assert.equal(f.count('prompt'), 0);
});

test('a late credential after cancellation cannot sign in', async t => {
  const f = fixture(t);
  await f.signin.offer(); const callback = f.callback();
  f.signin.cancel(); await callback({ credential: 'late' });
  assert.deepEqual(f.credentials, []);
});

test('a changed eligibility check rejects credentials even before the state event arrives', async t => {
  const f = fixture(t);
  await f.signin.offer(); f.state.allowed = false;
  await f.callback()({ credential: 'busy' });
  assert.deepEqual(f.credentials, []);
});

test('manual button supersedes One Tap without inheriting its callback or intent', async t => {
  const f = fixture(t), manual = [];
  await f.signin.offer(); const old = f.callback();
  await f.signin.renderButton(target(), { isCurrent: () => true, onCredential: value => manual.push(value) });
  f.signin.cancelPrompt();
  await old({ credential: 'old-one-tap' });
  await f.callback()({ credential: 'explicit-button' });
  assert.deepEqual(f.credentials, []);
  assert.deepEqual(manual, ['explicit-button']);
});

test('a late optional config cannot override a newer button challenge', async t => {
  const resolvers = [];
  const f = fixture(t, { account: { getSignInConfig: () => new Promise(resolve => resolvers.push(resolve)) } });
  const prompt = f.signin.offer();
  const button = f.signin.renderButton(target(), { isCurrent: () => true, onCredential: () => {} });
  resolvers[1]({ ...f.config, nonce: 'new' }); await button;
  resolvers[0]({ ...f.config, nonce: 'old' }); await prompt;
  assert.deepEqual(f.calls.filter(call => call.kind === 'init').map(call => call.options.nonce), ['new']);
  assert.equal(f.count('prompt'), 0);
});

test('SDK failure leaves the manual sign-in path retryable', async t => {
  let failed = true;
  const f = fixture(t, { load: async () => { if (failed) throw new Error('offline'); return f.gsi; } });
  await f.signin.offer(); assert.equal(f.count('prompt'), 0);
  failed = false;
  await f.signin.renderButton(target(), { isCurrent: () => true, onCredential: () => {} });
  assert.equal(f.count('button'), 1);
});

test('retired proof never reaches the sign-in endpoint', async t => {
  const f = fixture(t);
  await f.signin.offer(); f.state.now += 9 * 60 * 1000;
  await f.callback()({ credential: 'expired' });
  assert.deepEqual(f.credentials, []);
  assert.deepEqual(f.errors, ['sign_in_expired']);
});

test('the challenge lifetime cancels an idle prompt without retrying it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  await f.signin.offer(); const callback = f.callback();
  t.mock.timers.tick(9 * 60 * 1000);
  await callback({ credential: 'too-late' });
  assert.deepEqual(f.credentials, []);
  assert.equal(f.signin.active, null);
  await f.signin.offer(); assert.equal(f.count('prompt'), 1);
});

test('chosen credential failures reach the existing recovery flow', async t => {
  const f = fixture(t, { onPromptCredential: () => { throw new Error('invalid_identity'); } });
  await f.signin.offer(); await f.callback()({ credential: 'bad' });
  assert.deepEqual(f.errors, ['invalid_identity']);
  assert.equal(f.signin.active, null);
});
