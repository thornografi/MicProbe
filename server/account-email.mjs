import { createAccountEmail } from './email-messages.mjs';

const HOUR = 3600000;
const encoder = new TextEncoder();
const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const deliveryPriority = { 'email.sent': 1, 'email.delivery_delayed': 2, 'email.delivered': 3,
    'email.failed': 4, 'email.suppressed': 5, 'email.bounced': 6, 'email.complained': 7 };

export function readEmailConfig(env) {
    return {
        enabled: env.MICPROBE_EMAIL_ENABLED === 'true',
        apiKey: env.MICPROBE_RESEND_API_KEY || '',
        webhookSecret: env.MICPROBE_RESEND_WEBHOOK_SECRET || '',
        origin: env.MICPROBE_PUBLIC_ORIGIN || 'https://micprobe.com',
        from: env.MICPROBE_EMAIL_FROM || 'MicProbe <notifications@micprobe.com>',
        replyTo: 'support@micprobe.com',
        sandbox: !['production', 'prod', 'live'].includes(env.MICPROBE_FREEMIUS_MODE),
        sandboxRecipients: String(env.MICPROBE_EMAIL_SANDBOX_RECIPIENTS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean)
    };
}

async function verifiedEvent(request, secret, now) {
    if (!secret) return { error: 'webhook_not_configured', status: 503 };
    const id = request.headers.get('svix-id') || '';
    const timestamp = request.headers.get('svix-timestamp') || '';
    if (!id || !/^\d+$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300) {
        return { error: 'invalid_signature', status: 403 };
    }
    const reader = request.body?.getReader();
    if (!reader) return { error: 'invalid_body', status: 400 };
    const chunks = [];
    let size = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 65536) { await reader.cancel(); return { error: 'body_too_large', status: 413 }; }
        chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const key = await crypto.subtle.importKey('raw', Uint8Array.from(atob(secret.replace(/^whsec_/, '')), c => c.charCodeAt(0)),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const signed = encoder.encode(`${id}.${timestamp}.${raw}`);
    let valid = false;
    for (const value of (request.headers.get('svix-signature') || '').split(' ')) {
        const [version, signature] = value.split(',');
        if (version !== 'v1' || !signature) continue;
        try { valid ||= await crypto.subtle.verify('HMAC', key, Uint8Array.from(atob(signature), c => c.charCodeAt(0)), signed); }
        catch { /* A malformed alternative must not bypass signature verification. */ }
    }
    if (!valid) return { error: 'invalid_signature', status: 403 };
    return { event: JSON.parse(raw) };
}

/** A persisted, leased outbox serves Node and Workers. The same payload/key is
 * retried only within Resend's 24-hour idempotency window, including timeouts. */
export function createAccountEmailService({ db, config, fetchImpl = fetch, now = Date.now, log = console }) {
    const sql = (query, ...values) => db.prepare(query).bind(...values);

    async function send(row) {
        const time = now();
        const token = crypto.randomUUID();
        const claim = await sql(`UPDATE email_outbox SET state = 'sending', lease_token = ?, lease_until = ?, updated_at = ?
            WHERE id = ? AND state IN ('pending', 'retry', 'sending') AND lease_until <= ? AND next_attempt_at <= ?`,
        token, time + 60000, time, row.id, time, time).run();
        if (!claim.meta.changes) return;
        const finish = (state, error = null, providerId = null, retryAt = 0) => sql(`UPDATE email_outbox
            SET state = ?, last_error = ?, provider_id = COALESCE(?, provider_id), next_attempt_at = ?,
            lease_until = 0, lease_token = NULL, updated_at = ? WHERE id = ? AND lease_token = ?`,
        state, error, providerId, retryAt, now(), row.id, token).run();
        // Also reject legacy queued welcome messages if a database is upgraded late.
        if (row.kind !== 'premium') return finish('cancelled', 'email_kind_disabled');
        if (row.first_attempt_at !== null && time - row.first_attempt_at >= 23 * HOUR) {
            return finish('needs_review', 'idempotency_window_elapsed');
        }
        const owner = await sql('SELECT email, name FROM accounts WHERE id = ?', row.user_id).first();
        const license = await sql(`SELECT active FROM account_licenses
            WHERE mode = ? AND license_id = ? AND user_id = ?`, row.mode, row.license_id, row.user_id).first();
        if (!owner || owner.email.toLowerCase() !== row.recipient || !license?.active) {
            return finish('cancelled', 'account_or_license_changed');
        }
        if (await sql('SELECT reason FROM email_suppressions WHERE recipient = ?', row.recipient).first()) {
            return finish('suppressed', 'recipient_suppressed');
        }
        const sandbox = config.sandbox || row.mode === 'sandbox';
        if (sandbox && !config.sandboxRecipients.includes(row.recipient)) return finish('cancelled', 'sandbox_recipient_not_allowed');
        const payload = row.payload_json || JSON.stringify(createAccountEmail({ kind: row.kind,
            recipient: row.recipient, name: owner.name, sandbox }, config));
        await sql(`UPDATE email_outbox SET payload_json = ?, attempts = attempts + 1,
            first_attempt_at = COALESCE(first_attempt_at, ?) WHERE id = ? AND lease_token = ?`, payload, time, row.id, token).run();
        try {
            const response = await fetchImpl('https://api.resend.com/emails', {
                method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(12000),
                headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json',
                    'Idempotency-Key': `micprobe/${row.id}` }, body: payload
            });
            const result = await response.json().catch(() => ({}));
            if (response.ok && typeof result.id === 'string') return finish('sent', null, result.id);
            // Stay within the owner's free-plan budget. Quota-rejected notices
            // are dropped permanently; short-lived request throttling still retries.
            if (response.status === 429 && ['daily_quota_exceeded', 'monthly_quota_exceeded'].includes(result.name)) {
                return finish('cancelled', result.name);
            }
            if ([408, 409, 429].includes(response.status) || response.status >= 500 || response.ok) {
                return finish('retry', `provider_${response.status}`, null, time + Math.min(HOUR, 60000 * 2 ** Math.min(row.attempts, 6)));
            }
            return finish('needs_review', `provider_${response.status}`);
        } catch {
            return finish('retry', 'delivery_uncertain', null, time + Math.min(HOUR, 60000 * 2 ** Math.min(row.attempts, 6)));
        }
    }

    async function flush() {
        if (!db || !config.enabled || !config.apiKey) return;
        try {
            const time = now();
            const { results } = await sql(`SELECT * FROM email_outbox WHERE state IN ('pending', 'retry', 'sending')
                AND next_attempt_at <= ? AND lease_until <= ? ORDER BY created_at LIMIT 2`, time, time).all();
            // Two bounded requests fit Workers' post-response execution window.
            // Provider rate limits are persisted as retries, not busy-waited.
            for (const row of results) await send(row);
        } catch { log.error('MicProbe email outbox unavailable; pending notifications remain queued.'); }
    }

    async function handle(request) {
        if (new URL(request.url).pathname !== '/api/resend/webhook') return null;
        if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
        if (!db) return json({ error: 'email_storage_unavailable' }, 503);
        let verified;
        try { verified = await verifiedEvent(request, config.webhookSecret, now()); }
        catch { return json({ error: 'invalid_webhook' }, 400); }
        if (verified.error) return json({ error: verified.error }, verified.status);
        const event = verified.event;
        const priority = deliveryPriority[event?.type];
        const data = event?.data;
        const fromAddress = String(data?.from || '').match(/<?([^\s<>]+@[^\s<>]+)>?$/)?.[1]?.toLowerCase();
        if (!priority || !fromAddress?.endsWith('@micprobe.com')) return json({ ok: true, ignored: true });
        const occurred = Date.parse(event.created_at);
        if (typeof data.email_id !== 'string' || !Number.isFinite(occurred)) return json({ error: 'invalid_event' }, 400);
        const statements = [sql(`INSERT INTO email_delivery (provider_id, status, occurred_at, priority) VALUES (?, ?, ?, ?)
            ON CONFLICT(provider_id) DO UPDATE SET status = excluded.status, occurred_at = excluded.occurred_at, priority = excluded.priority
            WHERE excluded.priority > email_delivery.priority`, data.email_id, event.type, occurred, priority)];
        if (['email.bounced', 'email.complained'].includes(event.type)) {
            for (const recipient of (Array.isArray(data.to) ? data.to : []).slice(0, 50)) {
                if (typeof recipient !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(recipient)) continue;
                statements.push(sql(`INSERT INTO email_suppressions (recipient, reason, created_at) VALUES (?, ?, ?)
                    ON CONFLICT(recipient) DO NOTHING`, recipient.toLowerCase(), event.type, occurred));
            }
        }
        try { await db.batch(statements); }
        catch { return json({ error: 'email_storage_unavailable' }, 503); }
        return json({ ok: true });
    }
    return { flush, handle };
}
