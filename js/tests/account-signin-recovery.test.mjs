import test from 'node:test';
import assert from 'node:assert/strict';
import accountAccess, { AccountAccess } from '../modules/AccountAccess.js';
import AccountPanelUI from '../ui/AccountPanelUI.js';
import { GoogleSignIn } from '../modules/GoogleSignIn.js';

const reply = body => ({ ok: true, json: async () => ({ ok: true, ...body }) });
function panelFixture() {
  const container = { isConnected: true, children: [], replaceChildren(...children) { this.children = children; } };
  let options, checkouts = 0;
  const panel = Object.assign(Object.create(AccountPanelUI.prototype), {
    googleContainer: container, googleHint: { textContent: '' }, googleRetry: { hidden: true },
    dialog: { open: true }, view: 'account', accountState: { user: null }, signInRevision: 1, intent: 'checkout',
    google: { cancel() {}, renderButton: async (_container, value) => { options = value; } },
    onCheckout: async () => { checkouts++; }, message(value) { this.statusText = value; }
  });
  return { panel, container, options: () => options, checkouts: () => checkouts };
}

test('closing and reopening sign-in while its reply is pending cannot inherit the old checkout', async t => {
  let finish;
  t.mock.method(accountAccess, 'signInWithGoogle', () => new Promise(resolve => { finish = resolve; }));
  const f = panelFixture();
  await f.panel.renderGoogle();
  const pending = f.options().onCredential('chosen');
  f.panel.cancelSignIn();
  f.panel.signInRevision++;
  f.panel.intent = 'history';
  finish(); await pending;
  assert.equal(f.checkouts(), 0);
  assert.equal(f.panel.intent, 'history', 'A late reply must not clear the new dialog intent');
});

test('an uninterrupted explicit sign-in continues its checkout once', async t => {
  const f = panelFixture();
  t.mock.method(accountAccess, 'signInWithGoogle', async () => { f.panel.accountState.user = { id: 'chosen' }; });
  await f.panel.renderGoogle();
  await f.options().onCredential('chosen');
  assert.equal(f.checkouts(), 1);
  assert.equal(f.panel.intent, null);
});

test('sign-in continues testing or the open report without promising free report storage', async () => {
  for (const intent of ['signin', 'test-limit', 'report']) {
    const f = panelFixture();
    f.panel.accountState = { user: { id: 'chosen' }, premium: { unlocked: false } };
    let continued;
    f.panel.close = () => { f.panel.dialog.open = false; };
    f.panel.onContinue = value => { continued = value; };
    await f.panel.completeSignIn(intent);
    assert.equal(f.panel.dialog.open, false);
    assert.equal(continued, intent);
    assert.equal(f.checkouts(), 0);
  }
});

test('sign-in with an existing or pending purchase does not start another checkout', async () => {
  for (const premium of [{ unlocked: false }, { unlocked: false, pending: true }, { unlocked: true }]) {
    const f = panelFixture();
    f.panel.accountState = { user: { id: 'chosen' }, purchaseLinked: true, premium };
    f.panel.close = () => { f.panel.dialog.open = false; };
    await f.panel.completeSignIn('checkout');
    assert.equal(f.checkouts(), 0);
    if (!premium.unlocked) assert.match(f.panel.statusText, /Review your purchase status/);
    else assert.equal(f.panel.dialog.open, false);
  }
});

test('a failed session recheck still explains the error after the signed-out view was replaced', async t => {
  const f = panelFixture();
  t.mock.method(accountAccess, 'signInWithGoogle', async () => {
    f.container.isConnected = false;
    throw new Error('network_unavailable');
  });
  await f.panel.renderGoogle();
  await f.options().onCredential('chosen');
  assert.match(f.panel.statusText, /connection was interrupted/);
  assert.equal(f.checkouts(), 0);
});

test('a different account appearing during the final session check cannot continue sign-in intent', async () => {
  const account = new AccountAccess({ request: async path => path.endsWith('/google')
    ? reply({ user: { id: 'chosen-account' } })
    : path.includes('/config') ? reply({ configured: true }) : reply({ user: { id: 'other-tab-account' } }) });
  await assert.rejects(account.signInWithGoogle('chosen'), /account_changed/);
  assert.equal(account.getState().user.id, 'other-tab-account');
});

test('expiry removes the inactive Google button and exposes one explicit retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = panelFixture();
  let callback, posts = 0;
  t.mock.method(accountAccess, 'signInWithGoogle', async () => { posts++; });
  f.panel.google = new GoogleSignIn({
    account: { getSignInConfig: async () => ({ configured: true, googleClientId: 'test', nonce: 'test-nonce' }) },
    load: async () => ({ initialize: options => { callback = options.callback; },
      renderButton: container => container.children.push('google-button'), cancel() {} })
  });
  t.after(() => f.panel.google.cancel());
  await f.panel.renderGoogle();
  assert.equal(f.panel.googleRetry.hidden, true);
  assert.equal(f.container.children.length, 1);
  t.mock.timers.tick(9 * 60 * 1000);
  assert.deepEqual(f.container.children, []);
  assert.equal(f.panel.googleRetry.hidden, false);
  assert.match(f.panel.statusText, /expired/);
  await callback({ credential: 'stale' });
  assert.equal(posts, 0);
  await f.panel.renderGoogle();
  assert.equal(f.container.children.length, 1);
  assert.equal(f.panel.googleRetry.hidden, true);
});

test('long Google verification expires without signing out the account and accepts only a fresh retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = panelFixture(); let callback, exchanges = 0;
  f.panel.accountState.user = { id: 'account-a' };
  f.panel.switchAccountOwner = 'account-a'; f.panel.intent = 'switch';
  f.panel.close = () => { f.panel.dialog.open = false; };
  f.panel.google = new GoogleSignIn({
    account: { getSignInConfig: async () => ({ configured: true, googleClientId: 'test', nonce: 'test-nonce' }) },
    load: async () => ({ initialize: options => { callback = options.callback; },
      renderButton: () => {}, cancel() {} })
  });
  t.after(() => f.panel.google.cancel());
  t.mock.method(accountAccess, 'signInWithGoogle', async (_credential, options) => {
    exchanges++; assert.equal(options.switchFrom, 'account-a');
  });
  await f.panel.renderGoogle();
  const oldCallback = callback;
  t.mock.timers.tick(9 * 60 * 1000);
  assert.equal(f.panel.accountState.user.id, 'account-a');
  assert.equal(f.panel.googleRetry.hidden, false);
  assert.match(f.panel.statusText, /expired/);
  await oldCallback({ credential: 'late-after-phone-confirmation' });
  assert.equal(exchanges, 0);
  await f.panel.renderGoogle();
  await callback({ credential: 'fresh-proof' });
  assert.equal(exchanges, 1);
  assert.equal(f.panel.dialog.open, false);
});

test('lost sign-in replies refresh the session without replay or automatic checkout approval', async () => {
  const paths = [];
  const account = new AccountAccess({ request: async path => {
    paths.push(path);
    if (path.endsWith('/google')) throw new TypeError('Lost response after session commit');
    return reply({ user: { id: 'confirmed-account' }, premium: { unlocked: false } });
  } });
  account.state.configured = true;
  await assert.rejects(account.signInWithGoogle('chosen'), /sign_in_check_account/);
  assert.equal(account.getState().user.id, 'confirmed-account');
  assert.deepEqual(paths, ['/api/account/google', '/api/account/session']);
});

test('an offline sign-in stays retryable and never retries the credential', async () => {
  const paths = [];
  const account = new AccountAccess({ request: async path => { paths.push(path); throw new TypeError('offline'); } });
  await assert.rejects(account.signInWithGoogle('chosen'), /network_unavailable/);
  assert.equal(account.getState().user, null);
  assert.deepEqual(paths, ['/api/account/google', '/api/account/session']);
});

test('timeouts and invalid identities remain distinct and a rejected identity is not replayed', async () => {
  const timeout = new AccountAccess({ request: async () => { throw new DOMException('timeout', 'TimeoutError'); } });
  await assert.rejects(timeout.api('/session'), /network_timeout/);
  const paths = [];
  const invalid = new AccountAccess({ request: async path => {
    paths.push(path);
    return { ok: false, status: 401, json: async () => ({ ok: false, error: 'invalid_identity' }) };
  } });
  await assert.rejects(invalid.signInWithGoogle('invalid'), /invalid_identity/);
  assert.deepEqual(paths, ['/api/account/google']);
});
