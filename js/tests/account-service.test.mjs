import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAccountService, isAccountMutationAllowed } from '../../server/account-service.mjs';
import { AccountStore } from '../../server/account-store.mjs';
import { createNodeAccountDb } from '../../server/node-account-db.mjs';

const origin = 'https://micprobe.example';
const clientId = 'test-client.apps.googleusercontent.com';
const makeClaims = (sub, nonce, overrides = {}) => ({
    sub, nonce, aud: clientId, iss: 'https://accounts.google.com', email: `${sub}@example.com`, email_verified: true,
    name: `User ${sub}`, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, ...overrides
});
const makeReport = (id, overrides = {}) => ({
    version: '2.0', generatedAt: new Date().toISOString(), run: { id, type: 'test' },
    profile: { id: 'discord', requestedConstraints: { noiseSuppression: false }, constraints: { noiseSuppression: true } },
    audioMetrics: { status: 'measured', sampleCount: 48000 }, ...overrides
});
const license = (id, overrides = {}) => ({ licenseId: String(id), freemiusUserId: '900', mode: 'sandbox', active: true, verifiedAt: new Date().toISOString(), ...overrides });

function fixture(t, options = {}) {
    const db = createNodeAccountDb(':memory:');
    t.after(() => db.close());
    const service = createAccountService({ db, googleClientId: clientId, origin, verifyGoogleToken: async value => JSON.parse(value), ...options });
    const knownAccounts = new Map();
    const request = (path, { method = 'GET', body, cookie = '', headers = {} } = {}) => new Request(`${origin}${path}`, {
        method, headers: { Cookie: cookie, ...(knownAccounts.has(cookie) ? { 'X-MicProbe-Account': knownAccounts.get(cookie) } : {}),
            ...(method !== 'GET' ? { Origin: origin, 'X-MicProbe-Request': '1', 'Content-Type': 'application/json' } : {}), ...headers },
        ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {})
    });
    const send = (path, options) => service.handle(request(path, options));
    async function challenge() {
        const response = await send('/api/account/config');
        return { ...(await response.json()), cookie: response.headers.getSetCookie()[0].split(';')[0] };
    }
    async function login(sub, overrides = {}) {
        const config = await challenge();
        const response = await send('/api/account/google', { method: 'POST', cookie: config.cookie, body: { credential: JSON.stringify(makeClaims(sub, config.nonce, overrides)) } });
        assert.equal(response.status, 200, await response.clone().text());
        const value = await response.json();
        const sessionCookie = response.headers.getSetCookie().find(value => value.startsWith('micprobe_session=')).split(';')[0];
        knownAccounts.set(sessionCookie, value.user.id);
        return { ...value, cookie: sessionCookie, response };
    }
    return { db, service, request, send, challenge, login };
}

test('purchase management follows a linked purchase while Premium follows its current validity', async t => {
    const f = fixture(t), signedIn = await f.login('buyer');
    const session = async () => (await f.send('/api/account/session', { cookie: signedIn.cookie })).json();
    assert.equal((await session()).purchaseLinked, false, 'A free account has no purchase to manage');
    await f.service.saveLicense(signedIn.user.id, license(101));
    for (const [active, verifiedAt, pending] of [[true, Date.now(), false], [false, Date.now(), false], [false, 0, true]]) {
        await f.service.updateLicense('101', { active, verifiedAt });
        const state = await session();
        assert.equal(state.purchaseLinked, true);
        assert.equal(state.premium.unlocked, active);
        assert.equal(state.premium.pending, pending);
        assert.equal(state.licenseId, undefined, 'Public status does not expose license or buyer data');
    }
    const production = createAccountService({ db: f.db, googleClientId: clientId, origin, mode: 'production' });
    const otherMode = await (await production.handle(f.request('/api/account/session', { cookie: signedIn.cookie }))).json();
    assert.equal(otherMode.purchaseLinked, false, 'A sandbox purchase is not a production purchase');
    assert.equal(otherMode.premium.unlocked, false);
    const guest = await (await f.send('/api/account/session')).json();
    assert.equal(guest.purchaseLinked, false);
    const logout = await (await f.send('/api/account/logout', { method: 'POST', cookie: signedIn.cookie })).json();
    assert.equal(logout.purchaseLinked, false);
});

test('Google confirmation refreshes proof without replacing the session or its persistence choice', async t => {
    const f = fixture(t);
    const signedIn = await f.login('alice', { email: 'alice@gmail.com' });
    await f.db.prepare('UPDATE accounts SET google_verified_at = ? WHERE id = ?').bind(Date.now() - 86400001, signedIn.user.id).run();
    const sessions = await f.db.prepare('SELECT * FROM account_sessions').all();
    const challenge = await f.challenge();
    const options = { method: 'POST', cookie: `${signedIn.cookie}; ${challenge.cookie}`,
        headers: { 'X-MicProbe-Account': signedIn.user.id },
        body: { credential: JSON.stringify(makeClaims('alice', challenge.nonce, { email: 'alice@gmail.com' })), rememberMe: true } };
    const response = await f.send('/api/account/google/confirm', options);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok(response.headers.getSetCookie().every(cookie => cookie.startsWith('micprobe_login_nonce_') && cookie.includes('Max-Age=0')));
    assert.deepEqual(await f.db.prepare('SELECT * FROM account_sessions').all(), sessions);
    const account = await f.service.getUser(f.request('/api/account/session', { cookie: signedIn.cookie }));
    assert.ok(Date.now() - Date.parse(account.googleVerifiedAt) < 5000);
    assert.equal(account.authoritativeEmail, true);
    const publicState = await (await f.send('/api/account/session', { cookie: signedIn.cookie })).json();
    assert.equal(publicState.user.googleSub, undefined);
    assert.equal(publicState.user.googleVerifiedAt, undefined);
    assert.equal((await f.send('/api/account/google/confirm', options)).status, 401, 'Confirmation consumes its nonce once');
});

test('Google confirmation cannot switch accounts or create an account for another selected subject', async t => {
    const f = fixture(t);
    const signedIn = await f.login('alice');
    const before = await f.db.prepare('SELECT * FROM accounts').all();
    const sessions = await f.db.prepare('SELECT * FROM account_sessions').all();
    const challenge = await f.challenge();
    const response = await f.send('/api/account/google/confirm', { method: 'POST',
        cookie: `${signedIn.cookie}; ${challenge.cookie}`, headers: { 'X-MicProbe-Account': signedIn.user.id },
        body: { credential: JSON.stringify(makeClaims('bob', challenge.nonce, { email: 'alice@example.com' })) } });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'portal_account_mismatch');
    assert.deepEqual(await f.db.prepare('SELECT * FROM accounts').all(), before);
    assert.deepEqual(await f.db.prepare('SELECT * FROM account_sessions').all(), sessions);
});

test('Google confirmation requires the existing session, owner header and sign-in browser proof', async t => {
    const f = fixture(t);
    const signedIn = await f.login('alice');
    const challenge = await f.challenge();
    const base = { method: 'POST', cookie: `${signedIn.cookie}; ${challenge.cookie}`,
        headers: { 'X-MicProbe-Account': signedIn.user.id },
        body: { credential: JSON.stringify(makeClaims('alice', challenge.nonce)) } };
    for (const [change, status] of [
        [{ cookie: challenge.cookie }, 401], [{ headers: { 'X-MicProbe-Account': 'other' } }, 409],
        [{ cookie: signedIn.cookie }, 401], [{ headers: { ...base.headers, Origin: 'https://other.example' } }, 403],
        [{ body: { credential: JSON.stringify(makeClaims('alice', challenge.nonce, { aud: 'other-client' })) } }, 401]
    ]) {
        assert.equal((await f.send('/api/account/google/confirm', { ...base, ...change })).status, status);
    }
    assert.equal((await f.send('/api/account/google/confirm', base)).status, 200, 'Rejected requests do not refresh proof');
});

test('disabled accounts fail closed without affecting non-account routes', async () => {
    const service = createAccountService();
    const config = await service.handle(new Request(`${origin}/api/account/config`));
    assert.deepEqual(await config.json(), { ok: true, configured: false, googleClientId: null, nonce: null });
    const session = await service.handle(new Request(`${origin}/api/account/session`));
    assert.equal((await session.json()).user, null);
    assert.equal(await service.handle(new Request(`${origin}/api/freemius/config`)), null);
    assert.equal(await service.getUser(new Request(origin)), null);
    await assert.rejects(service.createCheckout('someone'), { status: 503 });
});

test('configured Google sign-in with a missing database fails unavailable instead of disabling accounts', async () => {
    const service = createAccountService({ googleClientId: clientId });
    for (const path of ['/api/account/config', '/api/account/session']) {
        const response = await service.handle(new Request(origin + path));
        assert.equal(response.status, 503);
        assert.equal((await response.json()).error, 'account_unavailable');
    }
});

test('session distinguishes pending verification from free, active and cancelled purchases', async t => {
    const f = fixture(t);
    const session = async cookie => (await (await f.send('/api/account/session', { cookie })).json()).premium;
    assert.deepEqual(await session(''), { unlocked: false, pending: false, inactiveReason: '', mode: 'sandbox' });
    const alice = await f.login('alice');
    assert.deepEqual(await session(alice.cookie), { unlocked: false, pending: false, inactiveReason: '', mode: 'sandbox' });
    await f.service.saveLicense(alice.user.id, license(100, { active: false, verifiedAt: 0 }));
    assert.deepEqual(await session(alice.cookie), { unlocked: false, pending: true, inactiveReason: '', mode: 'sandbox' });
    for (const state of [
        { active: true, verifiedAt: 0 },
        { active: true, verifiedAt: Date.now() },
        { active: false, verifiedAt: Date.now() }
    ]) {
        await f.service.updateLicense('100', state);
        assert.deepEqual(await session(alice.cookie), { unlocked: state.active, pending: false, inactiveReason: '', mode: 'sandbox' });
    }
});

test('local migrations upgrade an existing 0001 database once while preserving purchases and reports', async t => {
    const temporaryRoot = fileURLToPath(new URL('../../.tmp/', import.meta.url));
    mkdirSync(temporaryRoot, { recursive: true });
    const directory = mkdtempSync(join(temporaryRoot, 'account-migration-test-'));
    t.after(() => {
        assert.ok(directory.startsWith(join(temporaryRoot, 'account-migration-test-')));
        rmSync(directory, { recursive: true, force: true });
    });
    const filename = join(directory, 'legacy.sqlite');
    const legacy = new DatabaseSync(filename);
    legacy.exec(readFileSync(new URL('../../migrations/0001_accounts.sql', import.meta.url), 'utf8'));
    legacy.prepare('INSERT INTO accounts VALUES (?, ?, ?, ?, ?, ?)').run('legacy', 'stable-sub', 'owner@gmail.com', 'Owner', 1, 1);
    legacy.prepare('INSERT INTO account_licenses VALUES (?, ?, ?, ?, ?, ?)').run('legacy', 'sandbox', '123', '900', 1, 1);
    legacy.prepare('INSERT INTO account_reports VALUES (?, ?, ?, ?, ?, ?)').run('saved', 'legacy', 'run-1', JSON.stringify(makeReport('run-1')), 'Preserved note', 1);
    legacy.close();
    for (let reopen = 0; reopen < 2; reopen++) {
        const db = createNodeAccountDb(filename);
        try {
            const user = await db.prepare('SELECT * FROM accounts WHERE id = ?').bind('legacy').first();
            assert.equal(user.google_sub, 'stable-sub');
            assert.equal(user.email_authoritative, 0, 'old sessions must not gain fresh Google email proof');
            assert.equal(user.google_verified_at, null);
            assert.equal((await db.prepare('SELECT active FROM account_licenses').first()).active, 1);
            assert.equal((await db.prepare('SELECT note FROM account_reports').first()).note, 'Preserved note');
            assert.equal((await db.prepare('SELECT count(*) AS n FROM account_schema_migrations').first()).n, 12);
            assert.equal(user.picture_url, '', 'Existing accounts keep an initials fallback until their next verified login');
            assert.equal((await db.prepare('SELECT inactive_reason FROM account_licenses').first()).inactive_reason, '');
        } finally { db.close(); }
    }
});

test('verified Google photos update display data while identity and Premium remain independent', async t => {
    const f = fixture(t);
    const first = await f.login('photo-owner', { picture: 'https://lh3.googleusercontent.com/first=s96-c' });
    assert.equal(first.user.picture, 'https://lh3.googleusercontent.com/first=s96-c');
    assert.equal(first.premium.unlocked, false);
    const updated = await f.login('photo-owner', { picture: 'https://lh4.googleusercontent.com/new=s96-c' });
    assert.equal(updated.user.id, first.user.id);
    assert.equal(updated.user.picture, 'https://lh4.googleusercontent.com/new=s96-c');
    const session = await (await f.send('/api/account/session', { cookie: updated.cookie })).json();
    assert.equal(session.user.picture, updated.user.picture);
    for (const picture of [undefined, 'http://lh3.googleusercontent.com/a', 'https://lh3.googleusercontent.com.evil.example/a',
        'https://example.com/tracker', 'javascript:alert(1)', 'https://user@lh3.googleusercontent.com/a']) {
        const fallback = await f.login('photo-owner', { picture });
        assert.equal(fallback.user.id, first.user.id);
        assert.equal(fallback.user.picture, '');
    }
});

test('only verified Gmail and Workspace identities provide authoritative email proof without merging subjects', async t => {
    const f = fixture(t);
    for (const identity of [
        { sub: 'gmail', email: 'person@gmail.com', authoritative: true },
        { sub: 'workspace', email: 'person@company.example', hd: 'company.example', authoritative: true },
        { sub: 'external', email: 'person@company.example', authoritative: false },
        { sub: 'empty-hd', email: 'person@elsewhere.example', hd: ' ', authoritative: false }
    ]) {
        const signed = await f.login(identity.sub, identity);
        const stored = await f.service.getUser(f.request('/api/account/session', { cookie: signed.cookie }));
        assert.equal(stored.authoritativeEmail, identity.authoritative);
        assert.ok(Date.parse(stored.googleVerifiedAt) <= Date.now());
        assert.equal(signed.user.authoritativeEmail, undefined, 'internal recovery proof is not part of the public user snapshot');
    }
    assert.equal((await f.db.prepare('SELECT count(*) AS n FROM accounts').first()).n, 4);
});

test('a stale tab cannot read, save, edit, delete, or log out a different cookie account', async t => {
    const f = fixture(t);
    const alice = await f.login('alice');
    await f.service.saveLicense(alice.user.id, license(901));
    const bob = await f.login('bob');
    await f.service.saveLicense(bob.user.id, license(902));
    const saved = await (await f.send('/api/account/reports', { method: 'POST', cookie: bob.cookie,
        body: { report: makeReport('bob-run', { run: { id: 'bob-run', type: 'test', accountOwnerId: bob.user.id } }) } })).json();
    for (const header of [alice.user.id, '', 'anonymous']) {
        for (const item of [
            { path: '/api/account/reports', method: 'GET' },
            { path: '/api/account/reports', method: 'POST', body: { report: makeReport('private-alice-run') } },
            { path: `/api/account/reports/${saved.report.id}`, method: 'PATCH', body: { note: 'Wrong account' } },
            { path: `/api/account/reports/${saved.report.id}`, method: 'DELETE' },
            { path: '/api/account/logout', method: 'POST' }
        ]) {
            const response = await f.send(item.path, { ...item, cookie: bob.cookie, headers: { 'X-MicProbe-Account': header } });
            assert.equal(response.status, 409);
            assert.equal((await response.json()).error, 'account_changed');
        }
    }
    const current = await (await f.send('/api/account/session', { cookie: bob.cookie, headers: { 'X-MicProbe-Account': alice.user.id } })).json();
    assert.equal(current.user.id, bob.user.id, 'session refresh deliberately reveals the current cookie account');
    const history = await (await f.send('/api/account/reports', { cookie: bob.cookie })).json();
    assert.equal(history.reports.length, 1);
    assert.equal(history.reports[0].report.run.id, 'bob-run');
    assert.equal(history.reports[0].note, '');
});

test('sign-in consumes the browser nonce once, rotates sessions, and identifies by Google subject', async t => {
    const f = fixture(t);
    const challenge = await f.challenge();
    const body = { credential: JSON.stringify(makeClaims('alice', challenge.nonce)), rememberMe: true };
    const results = await Promise.all([
        f.send('/api/account/google', { method: 'POST', cookie: challenge.cookie, body }),
        f.send('/api/account/google', { method: 'POST', cookie: challenge.cookie, body })
    ]);
    assert.deepEqual(results.map(response => response.status).sort(), [200, 401]);
    const first = results.find(response => response.status === 200);
    const user = (await first.json()).user;
    const cookieHeader = first.headers.getSetCookie().find(value => value.startsWith('micprobe_session='));
    assert.match(cookieHeader, /HttpOnly; SameSite=Lax; Max-Age=2592000; Secure/);
    const sessionToken = cookieHeader.split(';')[0];
    const stored = await f.db.prepare('SELECT token_hash FROM account_sessions').first();
    assert.notEqual(stored.token_hash, sessionToken.split('=')[1]);

    const again = await f.login('alice', { email: 'new-address@example.com' });
    assert.equal(again.user.id, user.id);
    assert.equal(again.user.email, 'new-address@example.com');
    const another = await f.login('bob', { email: 'new-address@example.com' });
    assert.notEqual(another.user.id, user.id, 'matching email must not merge independent Google accounts');

    const next = await f.challenge();
    const rotated = await f.send('/api/account/google', { method: 'POST', cookie: `${sessionToken}; ${next.cookie}`, body: { credential: JSON.stringify(makeClaims('alice', next.nonce)) } });
    assert.equal(rotated.status, 200);
    assert.doesNotMatch(rotated.headers.getSetCookie().find(value => value.startsWith('micprobe_session=')), /Max-Age|Expires/i);
    assert.equal(await f.service.getUser(f.request('/api/account/session', { cookie: sessionToken })), null);
});

for (const selected of ['alice', 'bob']) test(`verified switch to ${selected} preserves or replaces only the current session`, async t => {
    const f = fixture(t), original = await f.login('alice'), proof = await f.challenge();
    const before = await f.db.prepare('SELECT * FROM account_sessions').all();
    const cookie = `${original.cookie}; ${proof.cookie}`;
    const options = { method: 'POST', cookie, headers: { 'X-MicProbe-Account': original.user.id },
        body: { credential: JSON.stringify(makeClaims(selected, proof.nonce)), rememberMe: true } };
    assert.equal((await f.send('/api/account/google/switch', { ...options, headers: {} })).status, 409);
    assert.deepEqual(await f.db.prepare('SELECT * FROM account_sessions').all(), before);
    const response = await f.send('/api/account/google/switch', options);
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json();
    const session = response.headers.getSetCookie().find(value => value.startsWith('micprobe_session='));
    if (selected === 'alice') {
        assert.equal(result.user.id, original.user.id);
        assert.equal(session, undefined, 'Choosing the same account preserves cookie persistence and expiry');
        assert.deepEqual(await f.db.prepare('SELECT * FROM account_sessions').all(), before);
    } else {
        assert.notEqual(result.user.id, original.user.id);
        assert.equal(result.premium.unlocked, false);
        assert.match(session, /Max-Age=2592000/);
        assert.equal((await (await f.send('/api/account/session', { cookie: original.cookie })).json()).user, null);
        assert.equal((await (await f.send('/api/account/session', { cookie: session.split(';')[0] })).json()).user.id, result.user.id);
    }
});

test('rejected switch credentials leave the current session intact', async t => {
    const f = fixture(t), original = await f.login('alice'), proof = await f.challenge();
    const response = await f.send('/api/account/google/switch', { method: 'POST',
        cookie: `${original.cookie}; ${proof.cookie}`, headers: { 'X-MicProbe-Account': original.user.id },
        body: { credential: JSON.stringify(makeClaims('bob', proof.nonce, { aud: 'wrong-client' })) } });
    assert.equal(response.status, 401);
    assert.equal((await (await f.send('/api/account/session', { cookie: original.cookie })).json()).user.id, original.user.id);
});

test('logout between switch verification and session replacement cannot resurrect a session', async t => {
    const f = fixture(t), original = await f.login('alice'), proof = await f.challenge();
    const addSession = AccountStore.prototype.addSession;
    t.mock.method(AccountStore.prototype, 'addSession', async function (...args) {
        await f.send('/api/account/logout', { method: 'POST', cookie: original.cookie, body: {} });
        return addSession.apply(this, args);
    });
    const response = await f.send('/api/account/google/switch', { method: 'POST', cookie: `${original.cookie}; ${proof.cookie}`,
        headers: { 'X-MicProbe-Account': original.user.id }, body: { credential: JSON.stringify(makeClaims('bob', proof.nonce)) } });
    assert.equal(response.status, 409);
    assert.equal((await f.db.prepare('SELECT count(*) AS n FROM account_sessions').first()).n, 0);
    assert.equal(response.headers.getSetCookie().length, 0);
});

test('competing account switches cannot both replace the same session', async t => {
    const f = fixture(t), original = await f.login('alice');
    const responses = await Promise.all(['bob', 'carol'].map(async sub => {
        const proof = await f.challenge();
        return f.send('/api/account/google/switch', { method: 'POST', cookie: `${original.cookie}; ${proof.cookie}`,
            headers: { 'X-MicProbe-Account': original.user.id }, body: { credential: JSON.stringify(makeClaims(sub, proof.nonce)) } });
    }));
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    assert.equal((await f.db.prepare('SELECT count(*) AS n FROM account_sessions').first()).n, 1);
});

test('only explicit remember-me creates a persistent session; both modes retain expiry and logout protection', async t => {
    const f = fixture(t);
    for (const rememberMe of [undefined, false, true, 'true', 1]) {
        const challenge = await f.challenge();
        const before = Date.now();
        const response = await f.send('/api/account/google', { method: 'POST', cookie: challenge.cookie,
            body: { credential: JSON.stringify(makeClaims('alice', challenge.nonce)), rememberMe } });
        assert.equal(response.status, 200);
        const user = (await response.json()).user;
        const cookies = response.headers.getSetCookie();
        const session = cookies.find(value => value.startsWith('micprobe_session='));
        assert.match(session, /; Path=\/; HttpOnly; SameSite=Lax/);
        assert.match(session, /; Secure$/);
        if (rememberMe === true) assert.match(session, /; Max-Age=2592000;/);
        else assert.doesNotMatch(session, /Max-Age|Expires/i);
        assert.match(cookies.find(value => value.startsWith('micprobe_login_nonce_')), /; Max-Age=0;/);
        const stored = await f.db.prepare('SELECT expires_at FROM account_sessions').first();
        assert.ok(stored.expires_at >= before + 2592000000 && stored.expires_at <= Date.now() + 2592000000);
        const cookie = session.split(';')[0];
        assert.equal((await f.service.getUser(f.request('/api/account/session', { cookie }))).id, user.id);
        const logout = await f.send('/api/account/logout', { method: 'POST', cookie, headers: { 'X-MicProbe-Account': user.id } });
        assert.equal(logout.status, 200);
        assert.match(logout.headers.get('set-cookie'), /micprobe_session=;.*Max-Age=0/);
        assert.equal(await f.service.getUser(f.request('/api/account/session', { cookie })), null);
    }
});

test('sign-in rejects wrong nonce, audience, issuer, expiry, email proof and request origin', async t => {
    const f = fixture(t);
    const challenge = await f.challenge();
    for (const overrides of [{ nonce: 'wrong' }, { aud: 'another-app' }, { iss: 'https://other.example' }, { exp: 1 }, { iat: Date.now() / 1000 + 120 }, { email_verified: false }]) {
        const response = await f.send('/api/account/google', { method: 'POST', cookie: challenge.cookie, body: { credential: JSON.stringify(makeClaims('alice', challenge.nonce, overrides)) } });
        assert.equal(response.status, 401);
    }
    const crossOrigin = await f.send('/api/account/google', { method: 'POST', cookie: challenge.cookie, headers: { Origin: 'https://other.example' }, body: {} });
    assert.equal(crossOrigin.status, 403);
    assert.equal(isAccountMutationAllowed(f.request('/api/account/logout', { method: 'POST', headers: { 'X-MicProbe-Request': '' } }), origin), false);
    const expiry = await f.challenge();
    await f.db.prepare('UPDATE account_login_challenges SET expires_at = 0').run();
    assert.equal((await f.send('/api/account/google', { method: 'POST', cookie: expiry.cookie, body: { credential: JSON.stringify(makeClaims('alice', expiry.nonce)) } })).status, 401);
});

test('two tabs keep independent browser-bound sign-in challenges and each remains single-use', async t => {
    const f = fixture(t);
    const configOnly = await f.send('/api/account/config?challenge=0');
    assert.equal((await configOnly.json()).nonce, null);
    assert.equal(configOnly.headers.get('set-cookie'), null);
    assert.equal((await f.db.prepare('SELECT count(*) AS n FROM account_login_challenges').first()).n, 0);
    const [tabA, tabB] = await Promise.all([f.challenge(), f.challenge()]);
    const cookie = `${tabA.cookie}; ${tabB.cookie}`;
    const bodyA = { credential: JSON.stringify(makeClaims('alice', tabA.nonce)) };
    const bodyB = { credential: JSON.stringify(makeClaims('alice', tabB.nonce)) };
    assert.equal((await f.send('/api/account/google', { method: 'POST', cookie: tabB.cookie, body: bodyA })).status, 401,
        'A signed identity still needs its own browser cookie');
    const first = await f.send('/api/account/google', { method: 'POST', cookie, body: bodyA });
    assert.equal(first.status, 200);
    assert.ok(first.headers.getSetCookie().some(value => value.startsWith(`${tabA.cookie.split('=')[0]}=;`)));
    assert.ok(!first.headers.getSetCookie().some(value => value.startsWith(`${tabB.cookie.split('=')[0]}=`)));
    assert.equal((await f.send('/api/account/google', { method: 'POST', cookie, body: bodyA })).status, 401);
    assert.equal((await f.send('/api/account/google', { method: 'POST', cookie, body: bodyB })).status, 200);
});

test('Google production verifier checks an actual RS256 signature against the fixed JWKS URL', async t => {
    const keypair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
    const jwk = { ...(await crypto.subtle.exportKey('jwk', keypair.publicKey)), kid: 'account-service-test', alg: 'RS256', use: 'sig' };
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        assert.equal(url, 'https://www.googleapis.com/oauth2/v3/certs');
        assert.equal(options.redirect, 'manual');
        return new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'Cache-Control': 'max-age=0' } });
    });
    const f = fixture(t, { verifyGoogleToken: undefined });
    const config = await f.challenge();
    const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const payload = `${encoded({ alg: 'RS256', kid: jwk.kid })}.${encoded(makeClaims('signed', config.nonce))}`;
    const signature = Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keypair.privateKey, new TextEncoder().encode(payload))).toString('base64url');
    const valid = await f.send('/api/account/google', { method: 'POST', cookie: config.cookie, body: { credential: `${payload}.${signature}` } });
    assert.equal(valid.status, 200);
    const second = await f.challenge();
    const altered = `${encoded({ alg: 'RS256', kid: jwk.kid })}.${encoded(makeClaims('other-person', second.nonce))}.${signature}`;
    assert.equal((await f.send('/api/account/google', { method: 'POST', cookie: second.cookie, body: { credential: altered } })).status, 401);
});

test('Google key redirects are rejected without following or consuming browser proof', async t => {
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        requests++;
        assert.equal(url, 'https://www.googleapis.com/oauth2/v3/certs');
        assert.equal(options.redirect, 'manual');
        return new Response(null, { status: 302, headers: { Location: 'https://other.example/keys' } });
    });
    const f = fixture(t, { verifyGoogleToken: undefined });
    const config = await f.challenge();
    const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const credential = `${encoded({ alg: 'RS256', kid: 'redirected-key' })}.${encoded(makeClaims('redirected', config.nonce))}.AAAA`;
    const response = await f.send('/api/account/google', { method: 'POST', cookie: config.cookie, body: { credential } });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'google_temporarily_unavailable');
    assert.equal(requests, 1);
    assert.equal(await f.db.prepare('SELECT count(*) AS n FROM account_login_challenges').first('n'), 1);
    assert.equal(await f.db.prepare('SELECT count(*) AS n FROM account_sessions').first('n'), 0);
});

test('Google key outages are retryable without consuming browser proof or creating sessions', async t => {
    t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 503 }));
    const f = fixture(t, { verifyGoogleToken: undefined });
    const config = await f.challenge();
    const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const credential = `${encoded({ alg: 'RS256', kid: 'outage' })}.${encoded(makeClaims('alice', config.nonce))}.AAAA`;
    const response = await f.send('/api/account/google', { method: 'POST', cookie: config.cookie, body: { credential } });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'google_temporarily_unavailable');
    assert.equal(await f.db.prepare('SELECT count(*) AS n FROM account_login_challenges').first('n'), 1);
    assert.equal(await f.db.prepare('SELECT count(*) AS n FROM account_sessions').first('n'), 0);
});

test('a verified identity without its browser cookie has actionable recovery and cannot sign in', async t => {
    const f = fixture(t);
    const config = await f.challenge();
    const response = await f.send('/api/account/google', { method: 'POST', body: { credential: JSON.stringify(makeClaims('alice', config.nonce)) } });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, 'sign_in_cookies_required');
    assert.equal(await f.db.prepare('SELECT count(*) AS n FROM account_sessions').first('n'), 0);
});

test('logout removes only the current session and expired sessions cannot access history', async t => {
    const f = fixture(t);
    const alice = await f.login('alice');
    const bob = await f.login('bob');
    const logout = await f.send('/api/account/logout', { method: 'POST', cookie: alice.cookie });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get('Set-Cookie'), /Max-Age=0/);
    assert.equal((await f.send('/api/account/reports', { cookie: alice.cookie })).status, 401);
    assert.equal((await f.send('/api/account/reports', { cookie: bob.cookie })).status, 200);
    await f.db.prepare('UPDATE account_sessions SET expires_at = 0').run();
    assert.equal((await f.send('/api/account/reports', { cookie: bob.cookie })).status, 401);
});

test('reports deduplicate each owner/run, ignore client entitlement, paginate and enforce ownership on edits', async t => {
    const f = fixture(t);
    const alice = await f.login('alice');
    await f.service.saveLicense(alice.user.id, license(901));
    const bob = await f.login('bob');
    await f.service.saveLicense(bob.user.id, license(902));
    const save = (user, id, extra = {}) => f.send('/api/account/reports', { method: 'POST', cookie: user.cookie, body: { report: makeReport(id, { ...extra, run: { id, type: "test", accountOwnerId: user.user.id } }), note: 'Gain reduced' } });
    const communicationContext = { scenario: 'local-call', internetMeasured: false };
    const first = (await (await save(alice, 'run-1', { premium: { unlocked: true }, userId: bob.user.id, communicationContext })).json()).report;
    const repeated = (await (await save(alice, 'run-1')).json()).report;
    assert.equal(repeated.id, first.id);
    assert.equal(first.report.premium, undefined);
    assert.equal(first.report.userId, undefined);
    assert.deepEqual(first.report.communicationContext, communicationContext);
    await save(alice, 'run-2');
    await save(alice, 'run-3');
    await save(bob, 'run-1');
    const page1 = await (await f.send('/api/account/reports?limit=2', { cookie: alice.cookie })).json();
    assert.equal(page1.reports.length, 2);
    assert.ok(page1.nextCursor);
    const page2 = await (await f.send(`/api/account/reports?limit=2&cursor=${page1.nextCursor}`, { cookie: alice.cookie })).json();
    assert.equal(page2.reports.length, 1);
    assert.equal(page2.nextCursor, null);
    assert.equal(new Set([...page1.reports, ...page2.reports].map(item => item.id)).size, 3);
    assert.equal((await (await f.send('/api/account/reports', { cookie: bob.cookie })).json()).reports.length, 1);
    assert.equal((await f.send(`/api/account/reports/${first.id}`, { method: 'DELETE', cookie: bob.cookie })).status, 404);
    assert.equal((await f.send(`/api/account/reports/${first.id}`, { method: 'PATCH', cookie: bob.cookie, body: { note: 'wrong user' } })).status, 404);
    const edited = await (await f.send(`/api/account/reports/${first.id}`, { method: 'PATCH', cookie: alice.cookie, body: { note: 'Microphone moved closer' } })).json();
    assert.equal(edited.report.note, 'Microphone moved closer');
    assert.equal((await f.send(`/api/account/reports/${first.id}`, { method: 'DELETE', cookie: alice.cookie })).status, 200);
});

test('history rejects excessive bodies, raw audio, malformed reports and prototype properties', async t => {
    const f = fixture(t);
    const user = await f.login('alice');
    await f.service.saveLicense(user.user.id, license(901));
    const post = body => {
      if (body?.report?.run) body.report.run.accountOwnerId = user.user.id;
      return f.send('/api/account/reports', { method: 'POST', cookie: user.cookie, body });
    };
    assert.equal((await post({ report: { run: { id: 'incomplete' } } })).status, 400);
    assert.equal((await post({ report: makeReport('raw', { deepAnalysis: { pcm: [1, 2] } }) })).status, 400);
    assert.equal((await post({ report: makeReport('notes'), note: 'n'.repeat(2001) })).status, 400);
    assert.equal((await post(JSON.stringify({ report: makeReport('big'), extra: 'x'.repeat(256 * 1024) }))).status, 413);
    const unsafe = makeReport('unsafe-2');
    unsafe.profile = JSON.parse('{"__proto__":{"admin":true}}');
    assert.equal((await post({ report: unsafe })).status, 400);
});

test('saving a duplicate and deleting it concurrently return consistent committed results', async t => {
    const f = fixture(t);
    const alice = await f.login('alice');
    await f.service.saveLicense(alice.user.id, license(901));
    const store = new AccountStore(f.db, 'sandbox');
    const report = makeReport('overlapping-save-delete');
    const original = await store.saveReport(alice.user.id, report, 'Original note');
    const [saved, deleted] = await Promise.all([
        store.saveReport(alice.user.id, report, 'Retry must not replace the note'),
        store.deleteReport(alice.user.id, original.id)
    ]);
    assert.equal(saved.id, original.id);
    assert.equal(saved.note, 'Original note');
    assert.equal(deleted, true);
    assert.deepEqual((await store.listReports(alice.user.id, 20, null)).reports, []);
});

test('checkout intent binds one purchase to its initiating account and retries are idempotent', async t => {
    const f = fixture(t);
    const alice = await f.login('alice');
    const bob = await f.login('bob');
    const state = await f.service.createCheckout(alice.user.id);
    assert.equal(await f.service.getCheckout(state, bob.user.id), null);
    await assert.rejects(f.service.completeCheckout(state, bob.user.id, license(100)), { status: 409 });
    assert.equal(await f.service.getLicense(bob.user.id), null);
    const linked = await f.service.completeCheckout(state, alice.user.id, license(100));
    assert.equal(linked.licenseId, '100');
    assert.equal((await f.service.completeCheckout(state, alice.user.id, license(100))).licenseId, '100');
    await assert.rejects(f.service.completeCheckout(state, alice.user.id, license(101)), { status: 409 });
    assert.equal((await f.service.getCheckout(state, alice.user.id)).licenseId, '100');
    assert.equal((await f.service.getLicenseById('100')).userId, alice.user.id);
    const stateB = await f.service.createCheckout(bob.user.id);
    await assert.rejects(f.service.completeCheckout(stateB, bob.user.id, license(100)), { status: 409 });
    assert.equal((await f.service.getCheckout(stateB, bob.user.id)).licenseId, null);
    await assert.rejects(f.service.saveLicense(bob.user.id, license(100)), { status: 409 });
    assert.equal((await f.service.getLicense(alice.user.id)).active, true);
    assert.equal((await (await f.send('/api/account/session', { cookie: alice.cookie })).json()).premium.unlocked, true);
    await f.service.updateLicense('100', { active: false, verifiedAt: new Date().toISOString() });
    assert.equal((await (await f.send('/api/account/session', { cookie: alice.cookie })).json()).premium.unlocked, false);
});

test('expired checkout cannot start ownership; competing completions commit exactly one license', async t => {
    const f = fixture(t);
    const alice = await f.login('alice');
    const expired = await f.service.createCheckout(alice.user.id);
    await f.db.prepare('UPDATE account_checkouts SET expires_at = 0').run();
    assert.equal(await f.service.getCheckout(expired, alice.user.id), null);
    await assert.rejects(f.service.completeCheckout(expired, alice.user.id, license(200)), { status: 409 });
    const state = await f.service.createCheckout(alice.user.id);
    const outcomes = await Promise.allSettled([
        f.service.completeCheckout(state, alice.user.id, license(201)),
        f.service.completeCheckout(state, alice.user.id, license(202))
    ]);
    assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
    const association = await f.service.getCheckout(state, alice.user.id);
    assert.equal((await f.service.getLicense(alice.user.id)).licenseId, association.licenseId);
    await f.db.prepare('UPDATE account_checkouts SET expires_at = 0').run();
    assert.equal((await f.service.completeCheckout(state, alice.user.id, license(association.licenseId))).licenseId, association.licenseId, 'successful checkout retries remain recoverable after expiry');
});

test('checkout completion uses one expiry decision for both ownership and intent writes', async t => {
    const f = fixture(t);
    const alice = await f.login('alice');
    const state = await f.service.createCheckout(alice.user.id);
    const { expiresAt } = await f.service.getCheckout(state, alice.user.id);
    let now = expiresAt - 1;
    t.mock.method(Date, 'now', () => now++);
    const linked = await f.service.completeCheckout(state, alice.user.id, license(250));
    assert.equal(linked.licenseId, '250');
    assert.equal((await f.service.getCheckout(state, alice.user.id)).licenseId, '250');
    assert.equal((await f.service.getLicenseById('250')).userId, alice.user.id);
});

test('sandbox and production purchase associations stay separate', async t => {
    const f = fixture(t);
    const alice = await f.login('alice');
    await f.service.saveLicense(alice.user.id, license(300));
    const production = createAccountService({ db: f.db, googleClientId: clientId, mode: 'production' });
    assert.equal(await production.getLicense(alice.user.id), null);
    assert.equal(await production.getLicenseById('300'), null);
    await assert.rejects(production.saveLicense(alice.user.id, license(300)), { status: 400 });
    await production.saveLicense(alice.user.id, license(300, { mode: 'production' }));
    await production.updateLicense('300', { active: false, verifiedAt: new Date().toISOString() });
    assert.equal((await f.service.getLicense(alice.user.id)).active, true);
    assert.equal((await production.getLicense(alice.user.id)).active, false);
});
