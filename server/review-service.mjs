import { isAccountMutationAllowed, requireAccountUser, readJson, validateReport } from './account-service.mjs';
import { AccountStore, accountError } from './account-store.mjs';
import { projectReviewReport } from '../js/modules/ReviewEvidence.js';
import { evaluateIndependentReport } from './independent-report.js';

const error = (code, status = 400) => accountError(status, code, code);
const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const only = (body, keys) => body && !Array.isArray(body) && typeof body === 'object' && Object.keys(body).every(key => keys.includes(key));
const identity = value => typeof value === 'string' && /^[\w-]{1,160}$/.test(value);

/** Compatibility owner for old review URLs. Assessment is stateless; legacy
 * reviews are read-only. Adoption proves only the selected capture. */
export function createReviewService({ db, accounts, billing, tests, origin, mode = 'sandbox', referenceCatalogs }) {
  const store = db ? new AccountStore(db, mode) : null;
  async function reserveRequest(user) {
    if (!user) return;
    const minute = Math.floor(Date.now() / 60000);
    const results = await db.batch([
      db.prepare('DELETE FROM account_review_requests WHERE minute < ?').bind(minute - 1),
      db.prepare(`INSERT INTO account_review_requests(user_id, minute, requests) VALUES (?, ?, 1)
        ON CONFLICT(user_id, minute) DO UPDATE SET requests = requests + 1 RETURNING requests`).bind(user.id, minute)
    ]);
    if (results[1].results[0].requests > 60) throw error('review_request_limit', 429);
  }
  async function premiumUser(request) {
    if (!accounts.configured) throw error('account_sign_in_required', 403);
    const user = requireAccountUser(request, await accounts.getUser(request));
    const license = await billing.refreshUserLicense(user.id);
    if (!license?.active) throw error(Date.parse(license?.verifiedAt) === 0
      ? 'billing_temporarily_unavailable' : 'premium_access_required', Date.parse(license?.verifiedAt) === 0 ? 503 : 403);
    return user;
  }
  return {
    async handle(request) {
      const path = new URL(request.url).pathname;
      if (!path.startsWith('/api/reviews/')) return null;
      try {
        if (!store) throw error('review_unavailable', 503);
        if (request.method !== 'POST') throw error('method_not_allowed', 405);
        if (!isAccountMutationAllowed(request, origin)) throw error('request_origin', 403);
        const input = await readJson(request, 256 * 1024);
        const action = path.slice('/api/reviews/'.length);
        if (action === 'assess') {
          if (!only(input, ['report', 'localAudioAvailable']) || !identity(input.report?.run?.id)) throw error('invalid_review_request');
          const user = await accounts.getUser(request);
          if (request.headers.get('X-MicProbe-Account') !== (user?.id || 'anonymous')) throw error('account_changed', 409);
          await reserveRequest(user);
          const raw = input.report, saved = user ? await store.getReportByRun(user.id, raw.run.id) : null;
          if (!saved) {
            if (raw.run.accountOwnerId && raw.run.accountOwnerId !== user?.id) throw error('review_report_not_owned', 403);
            await tests.verifyReviewRun(request, raw.run.id, user, { consumeCheck: true });
          }
          const evaluation = saved?.evaluation || evaluateIndependentReport(saved?.report || validateReport(projectReviewReport(raw)), referenceCatalogs);
          // Private numbers, instructions and model input never cross this boundary.
          return json({ ok: true, summary: evaluation.public });
        }
        const user = await premiumUser(request);
        await reserveRequest(user);
        if (action === 'archive') {
          if (!only(input, ['report', 'adoptGuest']) || input.adoptGuest !== true || !identity(input.report?.run?.id)) throw error('invalid_review_request');
          const raw = input.report, existing = await store.getReportByRun(user.id, raw.run.id);
          if (existing) return json({ ok: true, report: existing });
          if (raw.run.accountOwnerId && raw.run.accountOwnerId !== user.id) throw error('review_report_not_owned', 403);
          const report = validateReport(raw);
          await tests.verifyReviewRun(request, raw.run.id, user, { adopt: true });
          return json({ ok: true, report: await store.saveReport(user.id, report, '') });
        }
        if (action === 'load') {
          if (!only(input, ['runId']) || !identity(input.runId)) throw error('invalid_review_request');
          const row = await store.getReviewByRun(user.id, input.runId);
          return json({ ok: true, review: row ? { id: row.id, runId: input.runId, readOnly: true,
            source: 'legacy-review', revision: row.revision, state: JSON.parse(row.state_json) } : null });
        }
        if (['start', 'update'].includes(action)) throw error('review_workflow_retired', 410);
        throw error('not_found', 404);
      } catch (failure) {
        return json({ ok: false, error: failure.code || 'review_unavailable' }, failure.status || 503);
      }
    }
  };
}
