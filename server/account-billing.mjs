import { isAccountMutationAllowed, requireAccountUser, validateReport } from './account-service.mjs';
import { createFreemiusLicenses, LICENSE_FIELDS, hasSandboxCheckoutProof } from './freemius-license.mjs';
import { isDetailedReportInput } from './premium-report-evaluator.js';
import { GOOGLE_PROOF_MAX_AGE_MS } from './account-store.mjs';
import { freemiusPortalUrl } from '../js/modules/FreemiusPortal.js';

const encoder = new TextEncoder();
const RECHECK_MS = 24 * 60 * 60 * 1000;
const isPendingLicense = record => !!record && Date.parse(record.verifiedAt) === 0;

function problem(code, status = 400) {
  return Object.assign(new Error(code), { code, status });
}

function json(payload, status = 200) {
  return Response.json(payload, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function readBody(request, limit = 16384) {
  const reader = request.body?.getReader();
  if (!reader) throw problem('missing_body');
  const chunks = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw problem('payload_too_large', 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}

async function bodyJson(request, limit) {
  const raw = await readBody(request, limit);
  try { return JSON.parse(raw); } catch { throw problem('invalid_json'); }
}

async function validSignature(value, signature, secret) {
  if (!secret || !/^[a-f0-9]{64}$/i.test(signature || '')) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const bytes = Uint8Array.from(signature.match(/../g), byte => parseInt(byte, 16));
  return crypto.subtle.verify('HMAC', key, bytes, encoder.encode(value));
}

// Preserve the exact signed URL bytes; URLSearchParams reserialization can change
// spaces/escaping and invalidate a genuine Freemius redirect.
function unsignedUrl(raw) {
  const hashAt = raw.indexOf('#');
  const hash = hashAt < 0 ? '' : raw.slice(hashAt);
  const base = hashAt < 0 ? raw : raw.slice(0, hashAt);
  const queryAt = base.indexOf('?');
  if (queryAt < 0) return raw;
  const query = base.slice(queryAt + 1).split('&').filter(part => part.split('=')[0] !== 'signature');
  return base.slice(0, queryAt) + (query.length ? `?${query.join('&')}` : '') + hash;
}

function licenseCreatedAt(value) {
  if (typeof value !== 'string') return null;
  // Freemius SQL timestamps are UTC. Never apply the machine's local timezone,
  // or a backwards clock-skew allowance that could match an older purchase.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(value)
    ? `${value.replace(' ', 'T')}Z` : value;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(normalized)) return null;
  const time = Date.parse(normalized);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === normalized.slice(0, 19) ? time : null;
}

export function createAccountBilling({ accounts, config, checkoutUrl, enabled,
  evaluatePremiumReport, fetchImpl = fetch }) {
  const mode = config.mode || 'sandbox';
  const { api, verify: verifiedLicense, retrieve, restore } = createFreemiusLicenses(config, fetchImpl);

  async function refreshLicense(record, force = false) {
    if (!record) return null;
    if (!force && Date.now() - Date.parse(record.verifiedAt) < RECHECK_MS) return record;
    const checkedAt = Date.now();
    let active;
    let inactiveReason = '';
    try {
      active = (await retrieve(record.licenseId, record.freemiusUserId)).active;
    } catch (error) {
      if (error.status === 403 || error.status === 404) {
        active = false;
        inactiveReason = error.code || '';
      } else {
        // Keep the stored lifetime entitlement during a provider outage. Read it
        // again: another request may have revoked access while this one waited.
        if (force) throw error;
        return accounts.getLicenseById(record.licenseId);
      }
    }
    return accounts.updateLicense(record.licenseId, {
      active, inactiveReason, verifiedAt: new Date(checkedAt).toISOString(), checkedAt
    });
  }

  async function confirmFirstLink(record) {
    // A first provider response may predate a cancellation webhook that arrived
    // while the purchase was still unlinked. Persist ownership without access,
    // then check again where subsequent webhooks can update the same row.
    return isPendingLicense(record) ? refreshLicense(record, true) : record;
  }

  async function requireUser(request) {
    if (!enabled || !accounts.configured) throw problem('accounts_not_configured', 503);
    if (!isAccountMutationAllowed(request, new URL(request.url).origin)) throw problem('invalid_origin', 403);
    return requireAccountUser(request, await accounts.getUser(request));
  }

  async function refreshUserLicense(userId, force = false) {
    // Read the candidates once: refreshing an inactive row makes it newest and
    // must not cause that same row to hide another purchase that can grant access.
    const records = await accounts.getLicenses(userId);
    let unavailable;
    for (const record of records) {
      try {
        // An earlier provider request yielded; a webhook may since have changed
        // another candidate. Never authorize from the list's cached snapshot.
        const current = await accounts.getLicenseById(record.licenseId);
        if (current?.userId !== userId) continue;
        const updated = await refreshLicense(current, force);
        if (updated?.active) return updated;
      } catch (error) {
        if (error.status !== 503) throw error;
        unavailable = error;
      }
    }
    if (unavailable) throw unavailable;
    return accounts.getLicense(userId);
  }

  async function startCheckout(request, user) {
    const resolvedCheckoutUrl = typeof checkoutUrl === 'function' ? checkoutUrl() : checkoutUrl;
    if (!config.productId || !config.productSecret || !config.apiToken) throw problem('billing_not_configured', 503);
    if (mode === 'sandbox' && !hasSandboxCheckoutProof(resolvedCheckoutUrl)) throw problem('sandbox_token_unavailable', 503);
    if (!resolvedCheckoutUrl) throw problem('billing_not_configured', 503);
    const origin = new URL(request.url).origin;
    if (!origin.startsWith('https://')) throw problem('public_checkout_required', 409);
    const current = await refreshUserLicense(user.id);
    if (current?.active) throw problem('already_premium', 409);
    if (isPendingLicense(current)) throw problem('billing_temporarily_unavailable', 503);
    const target = new URL(resolvedCheckoutUrl);
    if (target.protocol !== 'https:' || target.hostname !== 'checkout.freemius.com') throw problem('invalid_checkout_target', 503);
    const state = await accounts.createCheckout(user.id);
    const success = new URL('/app', origin);
    success.searchParams.set('checkout_state', state);
    target.searchParams.set('success_url', success.toString());
    target.searchParams.set('cancel_url', new URL('/app', origin).toString());
    target.searchParams.set('billing_cycle', 'lifetime');
    target.searchParams.set('title', config.title || 'MicProbe Premium');
    target.searchParams.set('show_confirmation_dialog', 'false');
    // Prefill reduces checkout mistakes; mutable checkout URL parameters are
    // never accepted as identity proof when the webhook recovers a purchase.
    target.searchParams.set('user_email', user.email);
    target.searchParams.set('readonly_user', 'true');
    return json({ ok: true, checkoutUrl: target.toString() });
  }

  async function completePurchase(request, user) {
    const { url: raw } = await bodyJson(request);
    if (typeof raw !== 'string' || raw.length > 12000) throw problem('invalid_redirect');
    let url;
    try { url = new URL(raw); } catch { throw problem('invalid_redirect'); }
    if (url.origin !== new URL(request.url).origin || url.pathname !== '/app' || url.hash) throw problem('invalid_redirect', 403);
    for (const name of ['signature', 'license_id', 'user_id']) {
      if (url.searchParams.getAll(name).length !== 1) throw problem('invalid_redirect', 403);
    }
    if (url.searchParams.getAll('checkout_state').length > 1) throw problem('invalid_redirect', 403);
    if (!['license_id', 'user_id'].every(name => /^\d{1,30}$/.test(url.searchParams.get(name)))) {
      throw problem('invalid_redirect', 403);
    }
    if (!await validSignature(unsignedUrl(raw), url.searchParams.get('signature'), config.productSecret)) {
      throw problem('invalid_signature', 403);
    }
    const state = url.searchParams.get('checkout_state');
    // Hosted checkout uses the dashboard's static redirect and may omit the
    // requested success_url. A signed return alone never proves account ownership:
    // reuse the same bounded, Google-authoritative recovery as creation webhooks.
    if (!url.searchParams.has('checkout_state')) {
      const id = url.searchParams.get('license_id');
      const buyerId = url.searchParams.get('user_id');
      const existing = await accounts.getLicenseById(id);
      if (existing && (existing.userId !== user.id || existing.freemiusUserId !== buyerId)) {
        throw problem('checkout_not_found', 409);
      }
      const stored = existing ? await refreshLicense(existing, true)
        : await recoverNewPurchase(id, user.id, buyerId);
      if (!stored) throw problem('checkout_not_found', 409);
      return json({ ok: true, premium: { unlocked: stored.active === true, mode } });
    }
    if (!await accounts.getCheckout(state, user.id)) throw problem('checkout_not_found', 409);
    const license = await retrieve(url.searchParams.get('license_id'), url.searchParams.get('user_id'));
    const stored = await confirmFirstLink(await accounts.completeCheckout(state, user.id, {
      ...license, active: false, verifiedAt: 0
    }));
    return json({ ok: true, premium: { unlocked: stored?.active === true, mode } });
  }

  async function restorePurchase(request, user) {
    const { licenseKey } = await bodyJson(request);
    const checkedAt = Date.now();
    const license = await restore(licenseKey);
    const verifiedAt = new Date(checkedAt).toISOString();
    const stored = await accounts.saveLicense(user.id, { ...license, active: false, verifiedAt: 0 });
    if (isPendingLicense(stored)) {
      const confirmed = await confirmFirstLink(stored);
      return json({ ok: true, premium: { unlocked: confirmed?.active === true, mode } });
    }
    const sameBuyer = stored.freemiusUserId === license.freemiusUserId;
    // Explicit recovery may reopen a previously inactive purchase, but an older
    // provider response must still lose to a cancellation checked later.
    const refreshed = await accounts.updateLicense(license.licenseId, {
      active: sameBuyer, verifiedAt, checkedAt
    });
    if (!sameBuyer) throw problem('license_owner_changed', 403);
    return json({ ok: true, premium: { unlocked: refreshed?.active === true, mode } });
  }

  async function portal(request, user) {
    const record = await accounts.getLicense(user.id);
    if (!record) throw problem('purchase_not_linked', 409);
    const verifiedAt = Date.parse(user.googleVerifiedAt);
    if (!Number.isFinite(verifiedAt) || verifiedAt > Date.now() || Date.now() - verifiedAt > GOOGLE_PROOF_MAX_AGE_MS) {
      throw problem('portal_confirmation_required', 403);
    }
    if (!user.authoritativeEmail) throw problem('portal_identity_unverified', 403);
    if (![record.licenseId, record.freemiusUserId].every(id => /^[1-9]\d{0,29}$/.test(String(id)))) {
      throw problem('portal_owner_mismatch', 403);
    }
    // One shared deadline keeps all provider calls within the browser's timeout.
    const signal = AbortSignal.timeout(10000);
    const license = await api(`licenses/${record.licenseId}.json`, { fields: 'id,plugin_id,user_id,environment', signal });
    // Billing remains accessible for a refunded/expired purchase. These checks
    // prove its current owner/product/environment, not its Premium entitlement.
    if (String(license?.id) !== record.licenseId || String(license.plugin_id) !== String(config.productId)
        || String(license.user_id) !== record.freemiusUserId
        || ![mode === 'production' ? 0 : 1, mode === 'production' ? '0' : '1'].includes(license.environment)) {
      throw problem('portal_owner_mismatch', 403);
    }
    const buyer = await api(`users/${record.freemiusUserId}.json`, { fields: 'id,email', signal });
    // License-key possession alone does not establish billing-account ownership.
    if (String(buyer?.id) !== record.freemiusUserId || typeof buyer.email !== 'string'
        || !user.email || buyer.email.toLowerCase() !== user.email.toLowerCase()) {
      throw problem('portal_owner_mismatch', 403);
    }
    const checkCurrentOwner = async () => {
      const current = await requireUser(request);
      const linked = await accounts.getLicenseById(record.licenseId);
      if (current.id !== user.id || current.email !== user.email || !current.authoritativeEmail
          || linked?.userId !== user.id || linked.freemiusUserId !== record.freemiusUserId) {
        throw problem('account_changed', 409);
      }
    };
    await checkCurrentOwner();
    const result = await api('portal/login.json', { method: 'POST', body: { id: record.freemiusUserId }, signal });
    await checkCurrentOwner();
    const url = freemiusPortalUrl(result?.link);
    if (!url) throw problem('portal_unavailable', 503);
    // Return only the immediately used link. Never persist, log, or separately expose its token.
    return json({ ok: true, url });
  }

  async function recoverNewPurchase(id, expectedUserId = null, expectedBuyerId) {
    if (!/^\d{1,30}$/.test(String(id))) return null;
    const source = await api(`licenses/${id}.json`, { fields: LICENSE_FIELDS });
    const license = verifiedLicense(source, id, expectedBuyerId);
    const createdAt = licenseCreatedAt(source.created);
    if (createdAt === null) return null;
    const buyer = await api(`users/${encodeURIComponent(license.freemiusUserId)}.json`, { fields: 'id,email' });
    if (String(buyer.id) !== license.freemiusUserId) return null;
    return confirmFirstLink(await accounts.recoverCheckout(license, { email: buyer.email, createdAt, expectedUserId }));
  }

  async function webhook(request) {
    if (!enabled || !config.productSecret) throw problem('accounts_not_configured', 503);
    const raw = await readBody(request, 256 * 1024);
    if (!await validSignature(raw, request.headers.get('x-signature'), config.productSecret)) throw problem('invalid_signature', 403);
    let event;
    try { event = JSON.parse(raw); } catch { throw problem('invalid_json'); }
    if (!String(event.type || '').startsWith('license.') && !String(event.type || '').startsWith('payment.')) {
      return json({ ok: true, ignored: true });
    }
    const id = event.objects?.license?.id || event.data?.license_id || event.objects?.payment?.license_id;
    if (!id) return json({ ok: true, ignored: true });
    const existing = await accounts.getLicenseById(String(id));
    if (existing) {
      await refreshLicense(existing, true);
    } else if (event.type === 'license.created' || event.type === 'payment.created') {
      // A lost browser redirect can leave a new purchase unlinked. Restrict
      // recovery to a single recent Google-authoritative email owner whose
      // pending checkout contains the provider's actual license creation time.
      // This is email ownership evidence, not cryptographic checkout correlation.
      try {
        await recoverNewPurchase(id);
      } catch (error) {
        if (error.status === 403 || error.status === 404) return json({ ok: true, ignored: true });
        throw error;
      }
    }
    // Fetch current license state instead of applying the event's old snapshot.
    // Duplicate and out-of-order deliveries therefore cannot restore revoked access.
    return json({ ok: true });
  }

  async function handle(request) {
    const path = new URL(request.url).pathname;
    try {
      if (path === '/api/freemius/webhook' && request.method === 'POST') return await webhook(request);
      if (path === '/api/account/session' && request.method === 'GET' && enabled) {
        const user = await accounts.getUser(request);
        if (user) await refreshUserLicense(user.id);
        return null;
      }
      if (path === '/api/report/detailed' && request.method === 'POST' && enabled) {
        const user = await requireUser(request);
        const current = await refreshUserLicense(user.id);
        if (isPendingLicense(current)) throw problem('billing_temporarily_unavailable', 503);
        if (!current?.active) throw problem('premium_access_required', 403);
        const { report } = await bodyJson(request, 256 * 1024);
        if (!isDetailedReportInput(report)) throw problem('missing_report');
        const saved = report.run?.id ? await accounts.savedEvaluation?.(user.id, report.run.id) : null;
        if (saved) return json({ ok: true, detailed: saved.detailed });
        if (report.run?.accountOwnerId && report.run.accountOwnerId !== user.id) throw problem('report_not_owned', 403);
        return json({ ok: true, detailed: evaluatePremiumReport(validateReport(report)) });
      }
      if (path.startsWith('/api/account/reports') && enabled) {
        const user = request.method === 'GET' ? requireAccountUser(request, await accounts.getUser(request)) : await requireUser(request);
        await refreshUserLicense(user.id);
        return null;
      }
      if (!['/api/account/checkout', '/api/account/purchase', '/api/account/restore', '/api/account/portal', '/api/account/purchase/recheck'].includes(path)) return null;
      if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);
      const user = await requireUser(request);
      if (path.endsWith('/recheck')) {
        await refreshUserLicense(user.id, true);
        return json({ ok: true });
      }
      if (path.endsWith('/checkout')) return await startCheckout(request, user);
      if (path.endsWith('/purchase')) return await completePurchase(request, user);
      if (path.endsWith('/restore')) return await restorePurchase(request, user);
      return await portal(request, user);
    } catch (error) {
      return json({ ok: false, error: error.code || 'account_request_failed' }, error.status || 500);
    }
  }

  return { handle, refreshLicense, refreshUserLicense };
}
