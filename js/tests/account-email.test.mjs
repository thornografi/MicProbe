import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { unstable_splitSqlQuery } from 'wrangler';
import { createNodeAccountDb } from '../../server/node-account-db.mjs';
import { createAccountEmailService, readEmailConfig } from '../../server/account-email.mjs';
import { createAccountEmail } from '../../server/email-messages.mjs';

const start = 1800000000000;
function setup(t, overrides = {}) {
    const db = createNodeAccountDb(':memory:');
    t.after(() => db.close());
    let time = start;
    const calls = [];
    const config = { ...readEmailConfig({ MICPROBE_EMAIL_ENABLED: 'true', MICPROBE_RESEND_API_KEY: 'test',
        MICPROBE_FREEMIUS_MODE: 'production' }), ...overrides.config };
    const service = createAccountEmailService({ db, config, now: () => time,
        fetchImpl: async (_url, options) => { calls.push(options); return overrides.fetchImpl?.(options) || Response.json({ id: `email-${calls.length}` }); } });
    const account = (id = 'owner', email = 'owner@example.test') => db.prepare(`INSERT INTO accounts
        (id, google_sub, email, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(id, id, email, '<Owner>', time, time).run();
    const activate = (id = 'owner', licenseId = id) => db.prepare(`INSERT INTO account_licenses
        (user_id, mode, license_id, active, verified_at) VALUES (?, 'production', ?, 1, ?)`).bind(id, licenseId, time).run();
    const premium = async (id, email) => { await account(id, email); await activate(id); };
    const rows = () => db.prepare('SELECT * FROM email_outbox ORDER BY created_at, id').all().then(x => x.results);
    return { db, service, config, account, activate, premium, rows, calls, advance: ms => { time += ms; } };
}

test('account creation stays silent; verified Premium sends one escaped confirmation despite concurrent flushing', async t => {
    const f = setup(t);
    await f.account();
    await f.db.prepare("UPDATE accounts SET name = '<New owner>' WHERE id = 'owner'").run();
    await f.service.flush();
    assert.equal(f.calls.length, 0);
    assert.equal((await f.rows()).length, 0);
    await f.activate();
    await Promise.all([f.service.flush(), f.service.flush()]);
    await f.service.flush();
    assert.equal(f.calls.length, 1);
    const message = JSON.parse(f.calls[0].body);
    assert.match(message.html, /&lt;New owner&gt;/);
    assert.equal(message.subject, 'Your MicProbe Premium access is ready');
    assert.equal(message.reply_to, 'support@micprobe.com');
    assert.equal((await f.rows())[0].state, 'sent');
});

test('only verified active licenses notify; repeated activation does not resend and revoked pending licenses cancel', async t => {
    const f = setup(t);
    await f.account();
    await f.service.flush();
    await f.db.prepare(`INSERT INTO account_licenses (user_id, mode, license_id, active, verified_at)
        VALUES ('owner', 'production', '42', 0, 0)`).run();
    assert.equal((await f.rows()).length, 0);
    await f.db.prepare("UPDATE account_licenses SET active = 1, verified_at = ? WHERE license_id = '42'").bind(start).run();
    await f.service.flush();
    await f.db.prepare("UPDATE account_licenses SET active = 0 WHERE license_id = '42'").run();
    await f.db.prepare("UPDATE account_licenses SET active = 1 WHERE license_id = '42'").run();
    await f.service.flush();
    assert.equal(f.calls.length, 1);
    await f.db.prepare(`INSERT INTO account_licenses (user_id, mode, license_id, active, verified_at)
        VALUES ('owner', 'production', '43', 1, ?)`).bind(start + 1).run();
    await f.db.prepare("UPDATE account_licenses SET active = 0 WHERE license_id = '43'").run();
    await f.service.flush();
    assert.equal(f.calls.length, 1);
    assert.equal((await f.rows()).find(row => row.license_id === '43').state, 'cancelled');
});

test('provider timeout keeps intent and retries identical payload/key even after account display name changes', async t => {
    let unavailable = true;
    const f = setup(t, { fetchImpl: () => { if (unavailable) throw new Error('timeout'); return Response.json({ id: 'accepted' }); } });
    await f.premium();
    await f.service.flush();
    assert.equal((await f.rows())[0].state, 'retry');
    await f.db.prepare("UPDATE accounts SET name = 'Changed' WHERE id = 'owner'").run();
    unavailable = false;
    f.advance(61000);
    await f.service.flush();
    assert.equal(f.calls[0].body, f.calls[1].body);
    assert.equal(f.calls[0].headers['Idempotency-Key'], f.calls[1].headers['Idempotency-Key']);
    assert.equal((await f.rows())[0].provider_id, 'accepted');
});

test('daily and monthly quota rejections cancel notices without replaying them after the quota resets', async t => {
    for (const name of ['daily_quota_exceeded', 'monthly_quota_exceeded']) {
        await t.test(name, async t => {
            let quotaFull = true;
            const f = setup(t, { fetchImpl: () => quotaFull
                ? Response.json({ name, message: 'Quota exhausted' }, { status: 429 })
                : Response.json({ id: 'new-notice-after-reset' }) });
            await f.premium();
            await f.premium('second-owner', 'second@example.test');
            await f.service.flush();
            const rejected = await f.rows();
            assert.equal(f.calls.length, 2);
            assert.deepEqual(rejected.map(row => [row.state, row.last_error, row.attempts, row.lease_until]),
                [['cancelled', name, 1, 0], ['cancelled', name, 1, 0]]);
            assert.equal((await f.db.prepare('SELECT active FROM account_licenses').first()).active, 1);
            quotaFull = false;
            f.advance(32 * 24 * 3600000);
            // A fresh service represents a new Worker instance after quota reset.
            await createAccountEmailService({ db: f.db, config: f.config,
                now: () => start + 32 * 24 * 3600000,
                fetchImpl: async () => { throw Error('Cancelled notices must not be replayed'); } }).flush();
            await f.premium('new-account', 'new@example.test');
            await f.service.flush();
            assert.equal(f.calls.length, 3);
            assert.deepEqual((await f.rows()).map(row => row.state), ['cancelled', 'cancelled', 'sent']);
        });
    }
});

test('a temporary request-rate limit retries the same notice without treating it as an exhausted quota', async t => {
    let throttled = true;
    const f = setup(t, { fetchImpl: () => throttled
        ? Response.json({ name: 'rate_limit_exceeded' }, { status: 429 })
        : Response.json({ id: 'accepted-after-throttle' }) });
    await f.premium();
    await f.service.flush();
    assert.equal((await f.rows())[0].state, 'retry');
    throttled = false;
    f.advance(61000);
    await f.service.flush();
    assert.equal((await f.rows())[0].state, 'sent');
    assert.equal(f.calls[0].body, f.calls[1].body);
    assert.equal(f.calls[0].headers['Idempotency-Key'], f.calls[1].headers['Idempotency-Key']);
});

test('uncertain delivery is never retried past provider idempotency retention; stale leases recover', async t => {
    const f = setup(t, { fetchImpl: () => { throw new Error('timeout'); } });
    await f.premium();
    await f.db.prepare("UPDATE email_outbox SET state = 'sending', lease_until = ?").bind(start + 60000).run();
    await f.service.flush();
    assert.equal(f.calls.length, 0);
    f.advance(61000);
    await f.service.flush();
    f.advance(24 * 3600000);
    await f.service.flush();
    assert.equal(f.calls.length, 1);
    assert.equal((await f.rows())[0].state, 'needs_review');
});

test('disabled, sandbox recipient restriction, changed ownership and suppression prevent sends', async t => {
    const f = setup(t, { config: { enabled: false, sandbox: true, sandboxRecipients: ['owner@example.test'] } });
    await f.premium();
    await f.service.flush();
    assert.equal((await f.rows())[0].state, 'pending');
    f.config.enabled = true;
    await f.db.prepare("UPDATE accounts SET email = 'new@example.test' WHERE id = 'owner'").run();
    await f.service.flush();
    await f.premium('other', 'other@example.test');
    await f.service.flush();
    await f.premium('suppressed');
    await f.db.prepare("INSERT INTO email_suppressions VALUES ('owner@example.test', 'email.complained', ?)").bind(start).run();
    await f.service.flush();
    assert.equal(f.calls.length, 0);
    assert.deepEqual((await f.rows()).map(row => row.state), ['cancelled', 'cancelled', 'suppressed']);
});

async function signedRequest(event, secret, { timestamp = String(start / 1000), corrupt = false } = {}) {
    const body = JSON.stringify(event);
    const key = await crypto.subtle.importKey('raw', Buffer.from(secret.slice(6), 'base64'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`msg_test.${timestamp}.${body}`))).toString('base64');
    return new Request('https://micprobe.com/api/resend/webhook', { method: 'POST', body: corrupt ? body + ' ' : body,
        headers: { 'svix-id': 'msg_test', 'svix-timestamp': timestamp, 'svix-signature': `v1,broken v1,${signature}` } });
}

test('signed delivery events survive reordering and duplicates; complaints suppress future sends', async t => {
    const secret = 'whsec_' + Buffer.from('test-secret').toString('base64');
    const f = setup(t, { config: { webhookSecret: secret } });
    const event = { type: 'email.complained', created_at: new Date(start).toISOString(),
        data: { email_id: 'provider-before-response', from: 'MicProbe <notifications@micprobe.com>', to: ['owner@example.test'] } };
    for (const type of ['email.complained', 'email.delivered', 'email.complained']) {
        assert.equal((await f.service.handle(await signedRequest({ ...event, type }, secret))).status, 200);
    }
    assert.equal((await f.db.prepare('SELECT status FROM email_delivery').first()).status, 'email.complained');
    assert.equal((await f.db.prepare('SELECT count(*) AS n FROM email_suppressions').first()).n, 1);
    await f.premium();
    await f.service.flush();
    assert.equal(f.calls.length, 0);
    assert.equal((await f.service.handle(await signedRequest(event, secret, { corrupt: true }))).status, 403);
    assert.equal((await f.service.handle(await signedRequest(event, secret, { timestamp: String(start / 1000 - 301) }))).status, 403);
    assert.equal((await f.service.handle(await signedRequest({ ...event, padding: 'a'.repeat(66000) }, secret))).status, 413);
    const unrelated = { ...event, data: { ...event.data, from: 'support@scoreblur.app', email_id: 'other-product' } };
    assert.equal((await (await f.service.handle(await signedRequest(unrelated, secret))).json()).ignored, true);
    assert.equal((await f.db.prepare('SELECT count(*) AS n FROM email_delivery').first()).n, 1);
});

test('transaction rollback does not leave an email and permanent provider rejection requires review', async t => {
    const f = setup(t, { fetchImpl: () => Response.json({ message: 'unverified domain' }, { status: 403 }) });
    await assert.rejects(f.db.batch([
        f.db.prepare("INSERT INTO accounts VALUES ('rollback', 'rollback', 'rollback@example.test', '', ?, ?)").bind(start, start),
        f.db.prepare("INSERT INTO account_licenses (user_id, mode, license_id, active, verified_at) VALUES ('rollback', 'production', 'rollback', 1, ?)").bind(start),
        f.db.prepare('INSERT INTO missing_table VALUES (1)')
    ]));
    assert.equal((await f.rows()).length, 0);
    await f.premium();
    await f.service.flush();
    assert.equal((await f.rows())[0].state, 'needs_review');
    assert.equal((await f.db.prepare('SELECT count(*) AS n FROM accounts').first()).n, 1);
});

test('legacy welcome queues are retired and can never fall through to the Premium template', async t => {
    const f = setup(t);
    await f.account();
    // Model records left by the previous deployed version, including old payloads.
    for (const state of ['pending', 'retry', 'sending', 'needs_review', 'sent']) {
        await f.db.prepare(`INSERT INTO email_outbox
            (id,user_id,kind,mode,recipient,created_at,state,payload_json)
            VALUES (?, 'owner', 'welcome', 'account', 'owner@example.test', ?, ?, '{}')`).bind(state, start, state).run();
    }
    const migration = readFileSync(new URL('../../migrations/0005_premium_only_email.sql', import.meta.url), 'utf8');
    for (const sql of unstable_splitSqlQuery(migration)) await f.db.prepare(sql).run();
    assert.equal((await f.rows()).filter(row => row.state === 'cancelled').length, 4);
    assert.equal((await f.rows()).find(row => row.id === 'sent').state, 'sent');
    // The application guard also protects a late-migrated or externally queued row.
    await f.db.prepare("UPDATE email_outbox SET state='pending' WHERE id='pending'").run();
    await f.service.flush();
    assert.equal(f.calls.length, 0);
    assert.equal((await f.rows()).find(row => row.id === 'pending').last_error, 'email_kind_disabled');
    assert.throws(() => createAccountEmail({kind:'welcome'}, f.config), /Unsupported account email kind/);
});
