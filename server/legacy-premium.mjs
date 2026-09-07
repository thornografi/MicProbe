import { createFreemiusLicenses, billingProblem } from './freemius-license.mjs';

const encoder = new TextEncoder();
const TOKEN_MS = 60 * 60 * 1000;
const encode = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const decode = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));

// Legacy clients retain their purchase across token renewals. A signed token is
// only a license reference: every grant/renewal checks the current provider state.
export function createLegacyPremium(config, fetchImpl = fetch) {
  const licenses = createFreemiusLicenses(config, fetchImpl);
  async function key(usage) {
    if (!config.productSecret) throw billingProblem('missing_product_secret', 503);
    return crypto.subtle.importKey('raw', encoder.encode(config.productSecret),
      { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
  }
  async function issue(license) {
    const issuedAt = Date.now();
    const expiresAt = new Date(Math.min(issuedAt + TOKEN_MS, license.expiration ? Date.parse(license.expiration) : Infinity)).toISOString();
    const payload = { v: 2, licenseId: license.licenseId, freemiusUserId: license.freemiusUserId,
      mode: license.mode, planId: license.planId, pricingId: license.pricingId, iat: issuedAt, expiresAt };
    const encoded = encode(encoder.encode(JSON.stringify(payload)));
    const signature = encode(new Uint8Array(await crypto.subtle.sign('HMAC', await key('sign'), encoder.encode(encoded))));
    return { mode: license.mode, planId: license.planId, pricingId: license.pricingId,
      billingCycle: license.expiration ? '' : 'lifetime', expiration: license.expiration,
      accessToken: `${encoded}.${signature}`, tokenExpiresAt: expiresAt };
  }
  async function authorize(token) {
    let payload;
    try {
      if (typeof token !== 'string' || token.length > 4096) throw new Error();
      const parts = token.split('.');
      if (parts.length !== 2 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error();
      if (!await crypto.subtle.verify('HMAC', await key('verify'), decode(parts[1]), encoder.encode(parts[0]))) throw new Error();
      payload = JSON.parse(new TextDecoder().decode(decode(parts[0])));
    } catch { throw billingProblem('invalid_entitlement'); }
    // Old v1 claims contain no purchase identity. A full key can restore that
    // purchase safely; guessing a license from plan/email would merge owners.
    if (payload.v === 1) throw billingProblem('license_restore_required');
    if (payload.v !== 2 || payload.mode !== config.mode || !payload.freemiusUserId
      || (config.planId && payload.planId !== config.planId) || (config.pricingId && payload.pricingId !== config.pricingId)
      || !Number.isFinite(payload.iat) || payload.iat > Date.now() + 60000
      || !Number.isFinite(Date.parse(payload.expiresAt)) || Date.parse(payload.expiresAt) > payload.iat + TOKEN_MS) {
      throw billingProblem('invalid_entitlement');
    }
    // Expired references may renew only after this live canonical lookup. They
    // never authorize from their signature/old active status alone.
    return issue(await licenses.retrieve(payload.licenseId, payload.freemiusUserId, { lifetimeOnly: false }));
  }
  return {
    authorize,
    verifyPurchase: async params => issue(await licenses.retrieve(params.get('license_id'), params.get('user_id'), { lifetimeOnly: false })),
    restore: async licenseKey => issue(await licenses.restore(licenseKey, { lifetimeOnly: false }))
  };
}
