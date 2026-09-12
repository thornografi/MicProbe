import { createFreemiusLicenses } from './freemius-license.mjs';

// Pricing uses the same product, plan and optional tier as checkout. Never accept
// these from the visitor or expose the authenticated provider response directly.
export async function publicPricingResponse(config, { fetchImpl = fetch, cache, origin } = {}) {
  try {
    if (!config.apiToken || !config.productId || !config.planId) throw new Error('not_configured');
    const checkout = config.checkoutUrl ? new URL(config.checkoutUrl) : null;
    if (checkout && (checkout.hostname !== 'checkout.freemius.com' || checkout.protocol !== 'https:'
      || checkout.pathname.replace(/\/$/, '') !== `/product/${config.productId}/plan/${config.planId}`)) throw new Error('checkout_mismatch');
    const query = checkout?.searchParams || new URLSearchParams();
    const billing = query.get('billing_cycle') || config.billingCycle || 'lifetime';
    if (!['lifetime', 'life_time', '0'].includes(billing)) throw new Error('lifetime_required');
    const pricingId = config.pricingId || query.get('pricing_id') || '';
    if (config.pricingId && query.has('pricing_id') && config.pricingId !== query.get('pricing_id')) throw new Error('pricing_mismatch');
    const currency = (query.get('currency') || 'usd').toLowerCase();
    const licenses = Number(query.get('licenses') || '1');
    if (!['usd', 'eur', 'gbp'].includes(currency) || !Number.isInteger(licenses) || licenses < 1) throw new Error('invalid_tier');
    const selection = new URLSearchParams({ product: config.productId, plan: config.planId, pricing: pricingId,
      currency, licenses: String(licenses), mode: config.mode || 'sandbox' });
    const key = cache && origin ? new Request(`${origin}/api/pricing?${selection}`) : null;
    if (key) {
      try { const saved = await cache.match(key); if (saved) return saved; } catch { /* Cache is optional. */ }
    }
    const providerQuery = new URLSearchParams({ currency, count: '50' });
    const { pricing } = await createFreemiusLicenses(config, fetchImpl).api(
      `plans/${encodeURIComponent(config.planId)}/pricing.json?${providerQuery}`,
      { fields: 'id,plan_id,currency,licenses,lifetime_price,is_hidden', signal: AbortSignal.timeout(8000) });
    const candidates = Array.isArray(pricing) ? pricing.filter(item => item.is_hidden === false
      && String(item.plan_id) === String(config.planId) && item.currency?.toLowerCase() === currency
      && Number(item.licenses) === licenses && (!pricingId || String(item.id) === String(pricingId))) : [];
    const price = candidates.length === 1 ? candidates[0].lifetime_price : null;
    if (!['number', 'string'].includes(typeof price) || String(price).trim() === ''
      || !Number.isFinite(Number(price)) || Number(price) <= 0) throw new Error('price_unavailable');
    const response = Response.json({ amount: Number(price), currency: currency.toUpperCase(), billingCycle: 'lifetime' },
      { headers: { 'Cache-Control': 'public, max-age=300' } });
    if (key) { try { await cache.put(key, response.clone()); } catch { /* A cache failure must not hide a verified price. */ } }
    return response;
  } catch {
    return Response.json({ error: 'pricing_unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
