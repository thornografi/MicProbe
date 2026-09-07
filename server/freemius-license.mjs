// Canonical purchase checks shared by account and legacy Node/Worker adapters.
export const LICENSE_FIELDS = 'id,plugin_id,user_id,plan_id,pricing_id,environment,is_cancelled,expiration,created';
export const billingProblem = (code, status = 403) => Object.assign(new Error(code), { code, status });

export async function readBoundedBillingJson(message, maximum = 256 * 1024) {
  const reader = message.body?.getReader();
  if (!reader) throw billingProblem('invalid_json', 400);
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) { await reader.cancel(); throw billingProblem('payload_too_large', 413); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    try { return JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw billingProblem('invalid_json', 400); }
  } finally { reader.releaseLock(); }
}

export function createFreemiusLicenses(config, fetchImpl = fetch) {
  async function api(resource, { fields, method = 'GET', body } = {}) {
    if (!config.apiToken || !config.productId) throw billingProblem('billing_not_configured', 503);
    const url = new URL(`https://api.freemius.com/v1/products/${encodeURIComponent(config.productId)}/${resource}`);
    if (fields) url.searchParams.set('fields', fields);
    let response;
    try {
      response = await fetchImpl(url, {
        method, redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { Authorization: `Bearer ${config.apiToken}`, Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
    } catch { throw billingProblem('billing_temporarily_unavailable', 503); }
    if (response.status === 404) throw billingProblem('license_not_found', 404);
    if (!response.ok) throw billingProblem('billing_temporarily_unavailable', 503);
    try { return await readBoundedBillingJson(response); }
    catch { throw billingProblem('billing_temporarily_unavailable', 503); }
  }

  function verify(license, expectedId, expectedOwner, { lifetimeOnly = true } = {}) {
    if (!license || String(license.id) !== String(expectedId) || String(license.plugin_id) !== String(config.productId)) {
      throw billingProblem('license_product_mismatch');
    }
    const environment = config.mode === 'production' ? 0 : 1;
    if (![environment, String(environment)].includes(license.environment)) throw billingProblem('license_mode_mismatch');
    if (config.planId && String(license.plan_id) !== String(config.planId)) throw billingProblem('license_plan_mismatch');
    if (config.pricingId && String(license.pricing_id) !== String(config.pricingId)) throw billingProblem('license_pricing_mismatch');
    if (!license.user_id) throw billingProblem('license_owner_missing');
    if (expectedOwner && String(license.user_id) !== String(expectedOwner)) throw billingProblem('license_owner_changed');
    if (license.is_cancelled !== false) throw billingProblem('license_inactive');
    if (lifetimeOnly && license.expiration !== null) throw billingProblem('lifetime_license_required');
    let expiration = '';
    if (!lifetimeOnly && license.expiration !== null) {
      const raw = typeof license.expiration === 'string' ? license.expiration : '';
      const utc = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(raw) ? `${raw.replace(' ', 'T')}Z` : raw;
      const time = Date.parse(utc);
      if (!Number.isFinite(time) || time <= Date.now()) throw billingProblem('license_inactive');
      expiration = new Date(time).toISOString();
    }
    return { licenseId: String(license.id), freemiusUserId: String(license.user_id),
      mode: config.mode || 'sandbox', planId: String(license.plan_id), pricingId: String(license.pricing_id || ''),
      expiration, active: true, verifiedAt: new Date().toISOString() };
  }

  async function retrieve(id, owner, options) {
    if (!/^\d{1,30}$/.test(String(id))) throw billingProblem('invalid_license');
    return verify(await api(`licenses/${id}.json`, { fields: LICENSE_FIELDS }), id, owner, options);
  }
  async function restore(licenseKey, options) {
    if (typeof licenseKey !== 'string' || licenseKey.trim().length < 16 || licenseKey.length > 256) throw billingProblem('invalid_license_key');
    const query = new URLSearchParams({ search: licenseKey.trim(), count: '10' });
    const result = await api(`licenses.json?${query}`, { fields: `${LICENSE_FIELDS},secret_key` });
    const match = result.licenses?.find(item => item.secret_key === licenseKey.trim());
    if (!match) throw billingProblem('invalid_license_key');
    return verify(match, match.id, undefined, options);
  }
  return { api, verify, retrieve, restore };
}

export function hasSandboxCheckoutProof(checkoutUrl) {
  try {
    const url = new URL(checkoutUrl);
    return /^[a-f0-9]{32}$/i.test(url.searchParams.get('sandbox') || '')
      && /^\d{9,13}$/.test(url.searchParams.get('s_ctx_ts') || '');
  } catch { return false; }
}
