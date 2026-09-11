import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';
import { build } from 'esbuild';

test('Cloudflare D1 triggers, background sending and signed delivery callbacks work in workerd', { timeout: 30000 }, async t => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const bundle = await build({ stdin: { contents: `
        import worker from './worker/dev.js';
        export default { ...worker, async fetch(request, env, ctx) {
            if (new URL(request.url).pathname === '/test-scheduled') {
                const tasks = [];
                await worker.scheduled({}, env, { waitUntil: p => tasks.push(p) });
                await Promise.all(tasks);
                return new Response('done');
            }
            return worker.fetch(request, env, ctx);
        } };`, resolveDir: root }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
    const secret = 'whsec_' + Buffer.from('workerd-signature-secret').toString('base64');
    const calls = [];
    const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text,
        compatibilityDate: '2026-07-08', d1Databases: ['MICPROBE_ACCOUNTS'], bindings: {
            MICPROBE_PUBLIC_ORIGIN: 'https://micprobe.com', MICPROBE_FREEMIUS_MODE: 'production',
            MICPROBE_EMAIL_ENABLED: 'true', MICPROBE_RESEND_API_KEY: 'test-key', MICPROBE_RESEND_WEBHOOK_SECRET: secret
        }, outboundService: async request => {
            assert.equal(request.url, 'https://api.resend.com/emails');
            assert.equal(request.headers.get('authorization'), 'Bearer test-key');
            calls.push(await request.json());
            return Response.json({ id: 'workerd-email' });
        } }));
    t.after(() => runtime.dispose());
    const db = await runtime.getD1Database('MICPROBE_ACCOUNTS');
    const directory = new URL('../../migrations/', import.meta.url);
    for (const name of (await readdir(directory)).filter(n => n.endsWith('.sql')).sort()) {
        await db.batch(unstable_splitSqlQuery(await readFile(new URL(name, directory), 'utf8')).map(sql => db.prepare(sql)));
    }
    await db.prepare(`INSERT INTO accounts (id, google_sub, email, name, created_at, updated_at)
        VALUES ('test-owner', 'test-sub', 'delivered@resend.dev', 'Cloudflare test', ?, ?)`).bind(Date.now(), Date.now()).run();
    await runtime.dispatchFetch('https://micprobe.com/test-scheduled');
    assert.equal(calls.length, 0);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM email_outbox').first()).n, 0);
    await db.prepare(`INSERT INTO account_licenses (user_id, mode, license_id, active, verified_at)
        VALUES ('test-owner', 'production', 'test-license', 1, ?)`).bind(Date.now()).run();
    assert.equal((await runtime.dispatchFetch('https://micprobe.com/test-scheduled')).status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].subject, 'Your MicProbe Premium access is ready');
    assert.equal((await db.prepare('SELECT state FROM email_outbox').first()).state, 'sent');
    const body = JSON.stringify({ type: 'email.delivered', created_at: new Date().toISOString(),
        data: { email_id: 'workerd-email', from: 'MicProbe <notifications@micprobe.com>', to: ['delivered@resend.dev'] } });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const key = await crypto.subtle.importKey('raw', Buffer.from(secret.slice(6), 'base64'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`msg_workerd.${timestamp}.${body}`))).toString('base64');
    const response = await runtime.dispatchFetch('https://micprobe.com/api/resend/webhook', { method: 'POST', body,
        headers: { 'svix-id': 'msg_workerd', 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}` } });
    assert.equal(response.status, 200, await response.text());
    assert.equal((await db.prepare('SELECT status FROM email_delivery').first()).status, 'email.delivered');
    await runtime.dispatchFetch('https://micprobe.com/test-scheduled');
    assert.equal(calls.length, 1);
});
