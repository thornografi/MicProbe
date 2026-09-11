import { isAccountMutationAllowed, readJson } from './account-service.mjs';
import { countsAsCompletedTest as hasSufficientAudio } from '../js/modules/MeasurementValidity.js';

const DAY = 86400000;
const LEASE = 10 * 60 * 1000;
const COOKIE = 'micprobe_visitor';
const encoder = new TextEncoder();
const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))),
  byte => byte.toString(16).padStart(2, '0')).join('');
const problem = (code, status = 409) => Object.assign(new Error(code), { code, status });
const json = (body, status = 200, headers = {}) => Response.json(body, { status,
  headers: { 'Cache-Control': 'no-store', ...headers } });

/** Same D1 transactions run in Node SQLite and Workers. Client measurements are
 * evidence of sufficiency, not proof against a modified browser. No audio enters
 * this API; only an allowlisted, transient measurement summary is accepted. */
export function createTestAccess({ db, accounts, billing, legacy, origin, now = Date.now, visitorBurst = 200 }) {
  const stmt = (sql, ...values) => db.prepare(sql).bind(...values);
  async function networkHash(ip, timestamp) {
    if (!ip) return null;
    const day = Math.floor(timestamp / DAY);
    await stmt('INSERT OR IGNORE INTO test_access_days(day, salt) VALUES (?, ?)', day, crypto.randomUUID()).run();
    const salt = await stmt('SELECT salt FROM test_access_days WHERE day = ?', day).first('salt');
    // Daily secret salt prevents a persistent IP identifier. Raw IPs never enter D1.
    return hash(`${salt}:${ip}`);
  }
  async function visitor(request, network, timestamp, headers, create) {
    const token = request.headers.get('Cookie')?.split(';').map(value => value.trim())
      .find(value => value.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) || '';
    if (/^[a-f0-9-]{36}$/.test(token)) {
      const id = await hash(token);
      if (await stmt('SELECT id FROM test_visitors WHERE id = ? AND expires_at > ?', id, timestamp).first()) return id;
    }
    if (!create) throw problem('test_session_expired');
    if (network) {
      const hour = Math.floor(timestamp / 3600000);
      const rate = await stmt(`INSERT INTO test_visitor_rates(hour, ip_hash, attempts) VALUES (?, ?, 1)
        ON CONFLICT(hour, ip_hash) DO UPDATE SET attempts = attempts + 1 RETURNING attempts`, hour, network).first();
      if (rate.attempts > visitorBurst) throw problem('test_access_busy', 429);
    }
    const next = crypto.randomUUID(), id = await hash(next);
    await stmt('INSERT INTO test_visitors(id, expires_at) VALUES (?, ?)', id, timestamp + 30 * DAY).run();
    headers['Set-Cookie'] = `${COOKIE}=${next}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
    return id;
  }

  async function start(input, id, timestamp, user, network) {
    let premium = false;
    if (user) premium = (await billing.refreshUserLicense(user.id))?.active === true;
    else if (!accounts.configured && input.accessToken) {
      await legacy.authorize(input.accessToken);
      premium = true;
    }
    const day = Math.floor(timestamp / DAY), owner = user?.id || null;
    const limit = premium ? Number.MAX_SAFE_INTEGER : owner ? 5 : 1;
    const guestNetwork = !owner && !premium ? network : null;
    const statements = [
      stmt('DELETE FROM test_runs WHERE day < ?', day - 2),
      stmt('DELETE FROM test_visitors WHERE expires_at <= ?', timestamp),
      stmt('DELETE FROM test_access_days WHERE day < ?', day - 1),
      stmt('DELETE FROM test_visitor_rates WHERE hour < ?', Math.floor(timestamp / 3600000) - 24)
    ];
    // Adopt once, without duplicating a guest run or giving logout a new allowance.
    if (owner) statements.push(stmt('UPDATE test_runs SET user_id = ? WHERE visitor_id = ? AND user_id IS NULL AND day = ?', owner, id, day));
    const identity = owner ? 'user_id = ?' : 'visitor_id = ?';
    statements.push(stmt(`INSERT INTO test_runs(run_id, visitor_id, user_id, day, state, expires_at, guest_network_hash)
      SELECT ?, ?, ?, ?, 'reserved', ?, ? WHERE
      (SELECT COUNT(*) FROM test_runs WHERE ${identity} AND day = ?
        AND (state = 'completed' OR (state = 'reserved' AND expires_at > ?))) < ?
      AND (? IS NULL OR NOT EXISTS (SELECT 1 FROM test_runs WHERE guest_network_hash = ? AND day = ?
        AND (state = 'completed' OR (state = 'reserved' AND expires_at > ?))))
      ON CONFLICT(run_id) DO NOTHING`, input.runId, id, owner, day, timestamp + LEASE, guestNetwork,
    owner || id, day, timestamp, limit, guestNetwork, guestNetwork, day, timestamp));
    statements.push(stmt('SELECT * FROM test_runs WHERE run_id = ? AND visitor_id = ?', input.runId, id));
    const results = await db.batch(statements);
    const run = results.at(-1).results[0];
    if (!run) throw problem(owner ? 'free_test_limit' : 'guest_test_limit', 429);
    if (run.user_id !== owner || run.state !== 'reserved' || run.expires_at <= timestamp) throw problem('test_run_finished');
    return { ok: true };
  }

  async function settle(input, id, timestamp, action) {
    const run = await stmt('SELECT * FROM test_runs WHERE run_id = ? AND visitor_id = ?', input.runId, id).first();
    if (!run) throw problem('test_session_expired');
    if (run.state !== 'reserved') return { ok: true }; // terminal and idempotent
    const valid = action === 'complete' && hasSufficientAudio({ audioMetrics: input.evidence });
    // Expired reservations never displace a later admitted test.
    await stmt(`UPDATE test_runs SET state = ? WHERE run_id = ? AND visitor_id = ? AND state = 'reserved'`,
      valid && run.expires_at > timestamp ? 'completed' : 'released', input.runId, id).run();
    return { ok: true };
  }

  return {
    async verifyReviewRun(request, runId, user, { consumeCheck = false, adopt = false } = {}) {
      if (!db) throw problem('test_access_unavailable', 503);
      const id = await visitor(request, null, now(), {}, false);
      const row = await stmt('SELECT * FROM test_runs WHERE run_id = ? AND visitor_id = ?', runId, id).first();
      if (!row || row.state === 'reserved' || (row.user_id && row.user_id !== user?.id)) throw problem('review_report_not_owned', 403);
      if (consumeCheck) {
        const checked = await stmt(`UPDATE test_runs SET review_checks = review_checks + 1
          WHERE run_id = ? AND visitor_id = ? AND review_checks < 20 RETURNING run_id`, runId, id).first();
        if (!checked) throw problem('review_check_limit', 429);
      }
      if (adopt && user) {
        const adopted = await stmt(`UPDATE test_runs SET user_id = ? WHERE run_id = ? AND visitor_id = ?
          AND (user_id IS NULL OR user_id = ?) RETURNING run_id`, user.id, runId, id, user.id).first();
        if (!adopted) throw problem('review_report_not_owned', 403);
      }
      return true;
    },
    async handle(request, { ip = '' } = {}) {
      const path = new URL(request.url).pathname;
      if (!path.startsWith('/api/tests/')) return null;
      const headers = {};
      try {
        if (!db) throw problem('test_access_unavailable', 503);
        if (request.method !== 'POST') throw problem('method_not_allowed', 405);
        if (!isAccountMutationAllowed(request, origin)) throw problem('request_origin', 403);
        const action = path.slice('/api/tests/'.length);
        if (!['start', 'complete', 'release'].includes(action)) throw problem('not_found', 404);
        const input = await readJson(request, 8192);
        const allowed = action === 'start' ? ['runId', 'accessToken'] : action === 'complete' ? ['runId', 'evidence'] : ['runId'];
        if (Object.keys(input).some(key => !allowed.includes(key)) || typeof input.runId !== 'string'
          || !/^[\w-]{8,160}$/.test(input.runId)) throw problem('invalid_test_request', 400);
        if (input.accessToken !== undefined && (typeof input.accessToken !== 'string' || input.accessToken.length > 4096)) throw problem('invalid_test_request', 400);
        if (action === 'complete' && !validEvidence(input.evidence)) throw problem('invalid_test_evidence', 400);
        const timestamp = now();
        const user = action === 'start' ? await accounts.getUser(request) : null;
        if (action === 'start' && request.headers.get('X-MicProbe-Account') !== (user?.id || 'anonymous')) throw problem('account_changed');
        // Account quotas never depend on the shared network or visitor-creation burst.
        const network = action === 'start' && !user ? await networkHash(ip, timestamp) : null;
        const id = await visitor(request, network, timestamp, headers, action === 'start');
        const result = action === 'start' ? await start(input, id, timestamp, user, network) : await settle(input, id, timestamp, action);
        return json(result, 200, headers);
      } catch (error) {
        return json({ ok: false, error: error.code || 'test_access_unavailable' }, error.status || 503, headers);
      }
    }
  };
}

function validEvidence(value) {
  const object = v => v && typeof v === 'object' && !Array.isArray(v);
  const only = (v, keys) => object(v) && Object.keys(v).every(key => keys.includes(key));
  return only(value, ['status', 'sampleCount', 'durationMs', 'signal', 'clipping'])
    && ['measured', 'unavailable'].includes(value.status)
    && ['sampleCount', 'durationMs'].every(key => value[key] === null || (Number.isFinite(value[key]) && value[key] >= 0))
    && only(value.signal, ['rmsDb', 'peakDb']) && only(value.clipping, ['status', 'method', 'rate'])
    && ['rmsDb', 'peakDb'].every(key => value.signal[key] === null || Number.isFinite(value.signal[key]))
    && ['measured', 'unavailable'].includes(value.clipping.status)
    && ['sample-saturation', null].includes(value.clipping.method)
    && (value.clipping.rate === null || (Number.isFinite(value.clipping.rate) && value.clipping.rate >= 0 && value.clipping.rate <= 1));
}
