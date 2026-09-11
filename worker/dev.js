import { evaluatePremiumReport, isDetailedReportInput } from './premium-report-evaluator.js';
import { createAccountService } from '../server/account-service.mjs';
import { createTestAccess } from '../server/test-access.mjs';
import { createReviewService } from '../server/review-service.mjs';
import { createAccountBilling } from '../server/account-billing.mjs';
import { createLegacyPremium } from '../server/legacy-premium.mjs';
import { hasSandboxCheckoutProof, readBoundedBillingJson } from '../server/freemius-license.mjs';
import { isAccountMutationAllowed } from '../server/account-service.mjs';
import { createAccountEmailService, readEmailConfig } from '../server/account-email.mjs';

const CSP_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/client",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com/gsi/style",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data:",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "connect-src 'self' https://accounts.google.com/gsi/",
  "frame-src https://accounts.google.com/gsi/"
].join('; ');

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin'
};

const encoder = new TextEncoder();

function normalizeFreemiusMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'prod' || normalized === 'production' || normalized === 'live') return 'production';
  return 'sandbox';
}

function firstEnvValue(env, names) {
  for (const name of names) {
    const value = env[name];
    if (value) return value;
  }
  return '';
}

function readFreemiusEnv(env, requestUrl) {
  const mode = normalizeFreemiusMode(env.MICPROBE_FREEMIUS_MODE);
  const prefix = mode === 'production'
    ? 'MICPROBE_FREEMIUS_PRODUCTION_'
    : 'MICPROBE_FREEMIUS_SANDBOX_';
  const readValue = (key, fallbackNames = [], sandboxDefault = '') => {
    const modeSpecific = env[`${prefix}${key}`] || '';
    if (modeSpecific || mode === 'production') return modeSpecific;
    return firstEnvValue(env, fallbackNames) || sandboxDefault;
  };

  return {
    mode,
    productId: readValue('PRODUCT_ID', ['MICPROBE_FREEMIUS_PRODUCT_ID', 'FREEMIUS_PRODUCT_ID']),
    planId: readValue('PLAN_ID', ['MICPROBE_FREEMIUS_PLAN_ID', 'FREEMIUS_PLAN_ID']),
    pricingId: readValue('PRICING_ID', ['MICPROBE_FREEMIUS_PRICING_ID', 'FREEMIUS_PRICING_ID']),
    checkoutUrl: readValue('CHECKOUT_URL', ['MICPROBE_FREEMIUS_CHECKOUT_URL']),
    successUrl: readValue('SUCCESS_URL', ['MICPROBE_FREEMIUS_SUCCESS_URL'], new URL('/app', requestUrl).toString()),
    billingCycle: readValue('BILLING_CYCLE', ['MICPROBE_FREEMIUS_BILLING_CYCLE']),
    title: readValue('CHECKOUT_TITLE', ['MICPROBE_FREEMIUS_CHECKOUT_TITLE']) || 'MicProbe Premium',
    productSecret: readValue('PRODUCT_SECRET', ['MICPROBE_FREEMIUS_PRODUCT_SECRET', 'FREEMIUS_PRODUCT_SECRET']),
    // Sandbox checkout token uretimi icin gereken public key (pk_...) — secret degil, vars.
    publicKey: readValue('PUBLIC_KEY', ['MICPROBE_FREEMIUS_PUBLIC_KEY', 'FREEMIUS_PUBLIC_KEY']),
    // Opsiyonel: hazir sandbox token/ctx cifti (public key yerine dogrudan verilebilir).
    sandboxToken: env.MICPROBE_FREEMIUS_SANDBOX_TOKEN || '',
    sandboxCtx: env.MICPROBE_FREEMIUS_SANDBOX_CTX || '',
    // Canonical license verification is required before granting premium access.
    apiToken: readValue('API_TOKEN', ['MICPROBE_FREEMIUS_API_TOKEN', 'FREEMIUS_API_TOKEN'])
  };
}

// --- MD5 (RFC 1321) — WebCrypto MD5 desteklemez, Worker'da node:crypto yok.
// Freemius sandbox checkout token'i md5(ctx+productId+secret+publicKey+"checkout") ile uretiliyor.
function md5(input) {
  function rl(n, c) { return (n << c) | (n >>> (32 - c)); }
  function add(x, y) { const l = (x & 0xffff) + (y & 0xffff); return (((x >> 16) + (y >> 16) + (l >> 16)) << 16) | (l & 0xffff); }
  function cmn(q, a, b, x, s, t) { return add(rl(add(add(a, q), add(x, t)), s), b); }
  function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
  function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
  function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
  function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }
  const bytes = encoder.encode(input);
  const len = bytes.length * 8;
  const words = [];
  for (let i = 0; i < bytes.length; i += 1) words[i >> 2] = (words[i >> 2] || 0) | (bytes[i] << ((i % 4) * 8));
  words[len >> 5] = (words[len >> 5] || 0) | (0x80 << (len % 32));
  words[(((len + 64) >>> 9) << 4) + 14] = len;
  let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
  for (let i = 0; i < words.length; i += 16) {
    const oa = a, ob = b, oc = c, od = d; const w = (j) => words[i + j] || 0;
    a = ff(a, b, c, d, w(0), 7, -680876936); d = ff(d, a, b, c, w(1), 12, -389564586); c = ff(c, d, a, b, w(2), 17, 606105819); b = ff(b, c, d, a, w(3), 22, -1044525330);
    a = ff(a, b, c, d, w(4), 7, -176418897); d = ff(d, a, b, c, w(5), 12, 1200080426); c = ff(c, d, a, b, w(6), 17, -1473231341); b = ff(b, c, d, a, w(7), 22, -45705983);
    a = ff(a, b, c, d, w(8), 7, 1770035416); d = ff(d, a, b, c, w(9), 12, -1958414417); c = ff(c, d, a, b, w(10), 17, -42063); b = ff(b, c, d, a, w(11), 22, -1990404162);
    a = ff(a, b, c, d, w(12), 7, 1804603682); d = ff(d, a, b, c, w(13), 12, -40341101); c = ff(c, d, a, b, w(14), 17, -1502002290); b = ff(b, c, d, a, w(15), 22, 1236535329);
    a = gg(a, b, c, d, w(1), 5, -165796510); d = gg(d, a, b, c, w(6), 9, -1069501632); c = gg(c, d, a, b, w(11), 14, 643717713); b = gg(b, c, d, a, w(0), 20, -373897302);
    a = gg(a, b, c, d, w(5), 5, -701558691); d = gg(d, a, b, c, w(10), 9, 38016083); c = gg(c, d, a, b, w(15), 14, -660478335); b = gg(b, c, d, a, w(4), 20, -405537848);
    a = gg(a, b, c, d, w(9), 5, 568446438); d = gg(d, a, b, c, w(14), 9, -1019803690); c = gg(c, d, a, b, w(3), 14, -187363961); b = gg(b, c, d, a, w(8), 20, 1163531501);
    a = gg(a, b, c, d, w(13), 5, -1444681467); d = gg(d, a, b, c, w(2), 9, -51403784); c = gg(c, d, a, b, w(7), 14, 1735328473); b = gg(b, c, d, a, w(12), 20, -1926607734);
    a = hh(a, b, c, d, w(5), 4, -378558); d = hh(d, a, b, c, w(8), 11, -2022574463); c = hh(c, d, a, b, w(11), 16, 1839030562); b = hh(b, c, d, a, w(14), 23, -35309556);
    a = hh(a, b, c, d, w(1), 4, -1530992060); d = hh(d, a, b, c, w(4), 11, 1272893353); c = hh(c, d, a, b, w(7), 16, -155497632); b = hh(b, c, d, a, w(10), 23, -1094730640);
    a = hh(a, b, c, d, w(13), 4, 681279174); d = hh(d, a, b, c, w(0), 11, -358537222); c = hh(c, d, a, b, w(3), 16, -722521979); b = hh(b, c, d, a, w(6), 23, 76029189);
    a = hh(a, b, c, d, w(9), 4, -640364487); d = hh(d, a, b, c, w(12), 11, -421815835); c = hh(c, d, a, b, w(15), 16, 530742520); b = hh(b, c, d, a, w(2), 23, -995338651);
    a = ii(a, b, c, d, w(0), 6, -198630844); d = ii(d, a, b, c, w(7), 10, 1126891415); c = ii(c, d, a, b, w(14), 15, -1416354905); b = ii(b, c, d, a, w(5), 21, -57434055);
    a = ii(a, b, c, d, w(12), 6, 1700485571); d = ii(d, a, b, c, w(3), 10, -1894986606); c = ii(c, d, a, b, w(10), 15, -1051523); b = ii(b, c, d, a, w(1), 21, -2054922799);
    a = ii(a, b, c, d, w(8), 6, 1873313359); d = ii(d, a, b, c, w(15), 10, -30611744); c = ii(c, d, a, b, w(6), 15, -1560198380); b = ii(b, c, d, a, w(13), 21, 1309151649);
    a = ii(a, b, c, d, w(4), 6, -145523070); d = ii(d, a, b, c, w(11), 10, -1120210379); c = ii(c, d, a, b, w(2), 15, 718787259); b = ii(b, c, d, a, w(9), 21, -343485551);
    a = add(a, oa); b = add(b, ob); c = add(c, oc); d = add(d, od);
  }
  return [a, b, c, d].map((n) => { let h = ''; for (let j = 0; j < 4; j += 1) h += ((n >> (j * 8)) & 0xff).toString(16).padStart(2, '0'); return h; }).join('');
}

// Freemius sandbox aktivasyon parametreleri: ya hazir override (token+ctx) ya da
// public key + secret'tan uretilen imzali token. Yalnizca sandbox modda anlamli.
function resolveSandboxParams(freemiusEnv) {
  if (freemiusEnv.mode !== 'sandbox') return null;
  if (freemiusEnv.sandboxToken && freemiusEnv.sandboxCtx) {
    return { token: freemiusEnv.sandboxToken, ctx: freemiusEnv.sandboxCtx };
  }
  if (freemiusEnv.publicKey && freemiusEnv.productSecret && freemiusEnv.productId) {
    const ctx = Math.floor(Date.now() / 1000).toString();
    const token = md5(`${ctx}${freemiusEnv.productId}${freemiusEnv.productSecret}${freemiusEnv.publicKey}checkout`);
    return { token, ctx };
  }
  return null;
}

// Checkout URL'ini kur; sandbox modda gecerli sandbox parametrelerini ekle, gecersiz
// ?sandbox=true gibi eski degerleri temizle.
function buildFreemiusCheckoutUrl(freemiusEnv) {
  let base = freemiusEnv.checkoutUrl;
  if (!base && freemiusEnv.productId && freemiusEnv.planId) {
    base = `https://checkout.freemius.com/product/${encodeURIComponent(freemiusEnv.productId)}/plan/${encodeURIComponent(freemiusEnv.planId)}/`;
  }
  if (!base) return '';

  // Sandbox mode must never fall back to an ordinary checkout URL.
  if (freemiusEnv.mode === 'sandbox') {
    const sandbox = resolveSandboxParams(freemiusEnv);
    if (sandbox) {
      try {
        const url = new URL(base);
        url.searchParams.delete('sandbox');
        url.searchParams.delete('s_ctx_ts');
        url.searchParams.set('sandbox', sandbox.token);
        url.searchParams.set('s_ctx_ts', sandbox.ctx);
        return url.toString();
      } catch {
        return '';
      }
    }
    return hasSandboxCheckoutProof(base) ? base : '';
  }
  return base;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return bytesToHex(digest);
}

// Replay korumasi (KV) — FAIL-OPEN: binding yoksa veya hata olursa engellemez,
// yalnizca daha once tuketilmis imzada 'used' doner. KV atomik degildir; yaris
// penceresi kabul edilebilir (signed redirect zaten tek kullanimlik dar bir islem).
const REPLAY_TTL_SECONDS = 60 * 60 * 24 * 7;
async function consumeReplayGuard(env, signature) {
  const kv = env.MICPROBE_REPLAY_GUARD;
  if (!kv) return { status: 'disabled' };
  try {
    const key = await sha256Hex(signature);
    const existing = await kv.get(key);
    if (existing) return { status: 'used' };
    await kv.put(key, String(Date.now()), { expirationTtl: REPLAY_TTL_SECONDS });
    return { status: 'fresh' };
  } catch {
    return { status: 'error' };
  }
}


function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeBillingCycle(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/-/g, '_');
  if (normalized === 'yearly') return 'annual';
  if (normalized === 'life_time') return 'lifetime';
  return normalized;
}

function getFreemiusConfigIssues(freemiusEnv) {
  const issues = [];
  if (!freemiusEnv.productId) issues.push('missing_product_id');
  if (!freemiusEnv.checkoutUrl && (!freemiusEnv.productId || !freemiusEnv.planId)) {
    issues.push('missing_checkout_target');
  }
  if (!freemiusEnv.productSecret) {
    issues.push('missing_product_secret');
  }
  if (!freemiusEnv.apiToken) issues.push('missing_api_token');
  if (freemiusEnv.mode === 'sandbox' && !hasSandboxCheckoutProof(buildFreemiusCheckoutUrl(freemiusEnv))) {
    issues.push('sandbox_token_unavailable');
  }
  if (freemiusEnv.mode === 'production') {
    if (!freemiusEnv.successUrl) {
      issues.push('missing_production_success_url');
    } else if (!isHttpsUrl(freemiusEnv.successUrl)) {
      issues.push('production_success_url_must_be_https');
    }
  }
  return issues;
}

function validateFreemiusRedirectParams(freemiusEnv, params) {
  const licenseId = params.get('license_id') || '';
  if (!licenseId) return 'missing_license_id';

  if (freemiusEnv.planId) {
    const planId = params.get('plan_id') || '';
    if (!planId) return 'missing_plan_id';
    if (planId !== freemiusEnv.planId) return 'plan_mismatch';
  }

  if (freemiusEnv.pricingId) {
    const pricingId = params.get('pricing_id') || '';
    if (!pricingId) return 'missing_pricing_id';
    if (pricingId !== freemiusEnv.pricingId) return 'pricing_mismatch';
  }

  // NOT: Freemius signed-redirect'e billing_cycle parametresi eklemez (ScoreBlur'un
  // calisan entegrasyonu, test fixture'lari ve resmi redirect param listesi bunu
  // dogruluyor). Bu yuzden billing_cycle ASLA dogrulama sarti yapilmaz; satin alinan
  // plan zaten plan_id (ve varsa pricing_id) ile sabitleniyor. billing_cycle sadece
  // bilgi amacli entitlement'a yaziliyor.
  return null;
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...SECURITY_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

function stripSignatureParam(rawUrl) {
  const hashIndex = rawUrl.indexOf('#');
  const hash = hashIndex === -1 ? '' : rawUrl.slice(hashIndex);
  const withoutHash = hashIndex === -1 ? rawUrl : rawUrl.slice(0, hashIndex);
  const queryIndex = withoutHash.indexOf('?');

  if (queryIndex === -1) return rawUrl;

  const base = withoutHash.slice(0, queryIndex);
  const query = withoutHash.slice(queryIndex + 1);
  const parts = query.split('&');
  const filtered = parts.filter((part) => part.split('=')[0] !== 'signature');

  if (filtered.length === parts.length) return rawUrl;

  return `${base}${filtered.length ? `?${filtered.join('&')}` : ''}${hash}`;
}

function bytesToHex(bytes) {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}


function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;

  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

async function createFreemiusSignature(cleanUrl, productSecret) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(productSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(cleanUrl));
  return bytesToHex(signature);
}


function handleFreemiusConfig(freemiusEnv) {
  const issues = getFreemiusConfigIssues(freemiusEnv);
  const sandboxActive = freemiusEnv.mode === 'sandbox' ? hasSandboxCheckoutProof(buildFreemiusCheckoutUrl(freemiusEnv)) : null;
  const warnings = [];
  if (freemiusEnv.mode === 'sandbox' && !sandboxActive) {
    warnings.push('sandbox_token_unavailable');
  }
  return jsonResponse({
    configured: issues.length === 0,
    mode: freemiusEnv.mode,
    sandboxActive,
    productId: freemiusEnv.productId,
    planId: freemiusEnv.planId,
    pricingId: freemiusEnv.pricingId,
    checkoutUrl: buildFreemiusCheckoutUrl(freemiusEnv),
    successUrl: freemiusEnv.successUrl,
    billingCycle: freemiusEnv.billingCycle,
    title: freemiusEnv.title,
    issues,
    warnings
  });
}

async function handleFreemiusVerify(freemiusEnv, url, env) {
  if (!freemiusEnv.productSecret) {
    return jsonResponse({ ok: false, error: 'missing_product_secret' }, 503);
  }

  const rawUrl = url.searchParams.get('url');
  if (!rawUrl) {
    return jsonResponse({ ok: false, error: 'missing_url' }, 400);
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return jsonResponse({ ok: false, error: 'invalid_url' }, 400);
  }

  const signature = parsed.searchParams.get('signature');
  if (!signature) {
    return jsonResponse({ ok: false, error: 'missing_signature' }, 400);
  }

  const cleanUrl = stripSignatureParam(rawUrl);
  const expected = await createFreemiusSignature(cleanUrl, freemiusEnv.productSecret);
  if (!constantTimeEqual(expected, signature)) {
    return jsonResponse({ ok: false, error: 'invalid_signature' }, 401);
  }

  const params = parsed.searchParams;
  const validationError = validateFreemiusRedirectParams(freemiusEnv, params);
  if (validationError) {
    return jsonResponse({ ok: false, error: validationError }, 403);
  }

  let entitlement;
  try { entitlement = await createLegacyPremium(freemiusEnv).verifyPurchase(params); }
  catch (error) { return jsonResponse({ ok: false, error: error.code || 'license_check_failed' }, error.status || 503); }

  // Replay korumasi (yalnizca KV binding varsa; fail-open — sadece 'used' engeller).
  const replay = await consumeReplayGuard(env, signature);
  if (replay.status === 'used') {
    return jsonResponse({ ok: false, error: 'redirect_already_used' }, 409);
  }

  return jsonResponse({ ok: true, entitlement });
}

async function handleDetailedReport(freemiusEnv, request) {
  if (!freemiusEnv.productSecret) {
    return jsonResponse({ ok: false, error: 'missing_product_secret' }, 503);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: 'invalid_json' }, 400);
  }

  const authHeader = request.headers.get('Authorization') || '';
  const headerToken = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
  let entitlement;
  try { entitlement = await createLegacyPremium(freemiusEnv).authorize(headerToken || payload.entitlementToken); }
  catch (error) { return jsonResponse({ ok: false, error: error.code || 'invalid_entitlement' }, error.status || 503); }

  if (!isDetailedReportInput(payload.report)) {
    return jsonResponse({ ok: false, error: 'missing_report' }, 400);
  }

  return jsonResponse({
    ok: true,
    entitlement,
    detailed: evaluatePremiumReport(payload.report)
  });
}

function withSecurityHeaders(response, requestUrl) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(name)) headers.set(name, value);
  }

  const contentType = headers.get('Content-Type') || '';
  const pathname = new URL(requestUrl).pathname;
  if (contentType.includes('text/html') || pathname === '/' || pathname === '/app') {
    if (!pathname.startsWith('/api/account/')) {
      headers.set('Content-Security-Policy', CSP_POLICY);
      headers.set('Cache-Control', 'no-cache');
    }
  } else if (response.ok && pathname.startsWith('/assets/')) {
    // Only content-hashed files from the build are emitted under /assets/.
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function assetRequestFor(request) {
  const url = new URL(request.url);
  if (url.pathname === '/' || url.pathname === '/app' || url.pathname === '/app/') {
    url.pathname = url.pathname === '/' ? '/index.html' : '/app.html';
    return new Request(url, request);
  }
  return request;
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(createAccountEmailService({ db: env.MICPROBE_ACCOUNTS, config: readEmailConfig(env) }).flush());
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Move page visits to the canonical host; API requests keep their origin checks.
    if (env.MICPROBE_PUBLIC_ORIGIN && !url.pathname.startsWith('/api/') &&
        (request.method === 'GET' || request.method === 'HEAD')) {
      const target = new URL(env.MICPROBE_PUBLIC_ORIGIN);
      if (url.origin !== target.origin) {
        target.pathname = url.pathname;
        target.search = url.search;
        return withSecurityHeaders(Response.redirect(target.href, 308), request.url);
      }
    }
    const freemiusEnv = readFreemiusEnv(env, request.url);
    // Once Google sign-in is enabled, a missing D1 binding must fail closed
    // instead of silently restoring the anonymous token billing path.
    const accountConfigured = Boolean(env.MICPROBE_GOOGLE_CLIENT_ID);
    if (url.pathname === '/api/freemius/restore' && request.method === 'POST') {
      if (accountConfigured) return jsonResponse({ ok: false, error: 'account_sign_in_required' }, 403);
      if (!isAccountMutationAllowed(request, env.MICPROBE_PUBLIC_ORIGIN || url.origin)) return jsonResponse({ ok: false, error: 'invalid_origin' }, 403);
      try {
        const { licenseKey } = await readBoundedBillingJson(request, 16384);
        return jsonResponse({ ok: true, entitlement: await createLegacyPremium(freemiusEnv).restore(licenseKey) });
      } catch (error) { return jsonResponse({ ok: false, error: error.code || 'invalid_license_key' }, error.status || 400); }
    }
    if (url.pathname.startsWith('/api/reviews/') || url.pathname.startsWith('/api/tests/') || url.pathname.startsWith('/api/account/') || url.pathname === '/api/freemius/webhook' || url.pathname === '/api/resend/webhook'
      || (url.pathname === '/api/report/detailed' && accountConfigured)) {
      try {
        if (env.MICPROBE_PUBLIC_ORIGIN && url.origin !== new URL(env.MICPROBE_PUBLIC_ORIGIN).origin) {
          return jsonResponse({ ok: false, error: 'invalid_origin' }, 403);
        }
        const accounts = createAccountService({ db: env.MICPROBE_ACCOUNTS,
          googleClientId: env.MICPROBE_GOOGLE_CLIENT_ID || '', mode: freemiusEnv.mode,
          origin: env.MICPROBE_PUBLIC_ORIGIN || url.origin });
        const billing = createAccountBilling({ accounts, config: freemiusEnv,
          checkoutUrl: buildFreemiusCheckoutUrl(freemiusEnv), enabled: accountConfigured, evaluatePremiumReport });
        const email = createAccountEmailService({ db: env.MICPROBE_ACCOUNTS, config: readEmailConfig(env) });
        const tests = createTestAccess({ db: env.MICPROBE_ACCOUNTS, accounts, billing,
          legacy: createLegacyPremium(freemiusEnv), origin: env.MICPROBE_PUBLIC_ORIGIN || url.origin });
        const reviews = createReviewService({ db: env.MICPROBE_ACCOUNTS, accounts, billing, tests,
          mode: freemiusEnv.mode, origin: env.MICPROBE_PUBLIC_ORIGIN || url.origin });
        const response = await tests.handle(request, { ip: request.headers.get('CF-Connecting-IP') || '' })
          || await reviews.handle(request) || await email.handle(request) || await billing.handle(request) || await accounts.handle(request);
        if (response) {
          if (response.ok && !url.pathname.startsWith('/api/tests/') && !url.pathname.startsWith('/api/reviews/') && url.pathname !== '/api/resend/webhook' && ctx) ctx.waitUntil(email.flush());
          return withSecurityHeaders(response, request.url);
        }
        if (url.pathname.startsWith('/api/account/')) return jsonResponse({ ok: false, error: 'not_found' }, 404);
      } catch {
        return jsonResponse({ ok: false, error: 'account_service_unavailable' }, 503);
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/report/detailed') {
      return handleDetailedReport(freemiusEnv, request);
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('405 Method Not Allowed', {
        status: 405,
        headers: {
          ...SECURITY_HEADERS,
          'Content-Type': 'text/plain; charset=utf-8'
        }
      });
    }

    if (url.pathname === '/api/freemius/config') {
      const response = handleFreemiusConfig(freemiusEnv);
      const payload = await response.json();
      return jsonResponse({ ...payload, accountConfigured });
    }

    if (url.pathname === '/api/freemius/verify') {
      return handleFreemiusVerify(freemiusEnv, url, env);
    }

    const assetResponse = await env.ASSETS.fetch(assetRequestFor(request));
    return withSecurityHeaders(assetResponse, request.url);
  }
};
