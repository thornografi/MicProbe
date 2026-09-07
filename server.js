const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { evaluatePremiumReport, isDetailedReportInput } = require('./server/premium-report-evaluator');

const DEFAULT_PORT = 8080;
const basePort = (() => {
  const fromEnv = Number.parseInt(process.env.PORT || '', 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0 && fromEnv < 65536) return fromEnv;
  return DEFAULT_PORT;
})();
const strictPort = /^(1|true|yes)$/i.test(process.env.MICPROBE_STRICT_PORT || '');

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm'
};

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

function loadLocalEnvFile(filename) {
  const filePath = path.join(__dirname, filename);
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (!key || process.env[key] !== undefined) continue;

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

if (require.main === module) {
  loadLocalEnvFile('.env.local');
  loadLocalEnvFile('.env');
}

function normalizeFreemiusMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'prod' || normalized === 'production' || normalized === 'live') return 'production';
  return 'sandbox';
}

function firstEnvValue(names) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return '';
}

function readFreemiusEnv(mode) {
  const prefix = mode === 'production'
    ? 'MICPROBE_FREEMIUS_PRODUCTION_'
    : 'MICPROBE_FREEMIUS_SANDBOX_';
  const readValue = (key, fallbackNames = []) => {
    const modeSpecific = process.env[`${prefix}${key}`] || '';
    if (modeSpecific || mode === 'production') return modeSpecific;
    return firstEnvValue(fallbackNames);
  };

  return {
    mode,
    productId: readValue('PRODUCT_ID', ['MICPROBE_FREEMIUS_PRODUCT_ID', 'FREEMIUS_PRODUCT_ID']),
    planId: readValue('PLAN_ID', ['MICPROBE_FREEMIUS_PLAN_ID', 'FREEMIUS_PLAN_ID']),
    pricingId: readValue('PRICING_ID', ['MICPROBE_FREEMIUS_PRICING_ID', 'FREEMIUS_PRICING_ID']),
    checkoutUrl: readValue('CHECKOUT_URL', ['MICPROBE_FREEMIUS_CHECKOUT_URL']),
    successUrl: readValue('SUCCESS_URL', ['MICPROBE_FREEMIUS_SUCCESS_URL']),
    billingCycle: readValue('BILLING_CYCLE', ['MICPROBE_FREEMIUS_BILLING_CYCLE']),
    title: readValue('CHECKOUT_TITLE', ['MICPROBE_FREEMIUS_CHECKOUT_TITLE']) || 'MicProbe Premium',
    productSecret: readValue('PRODUCT_SECRET', ['MICPROBE_FREEMIUS_PRODUCT_SECRET', 'FREEMIUS_PRODUCT_SECRET']),
    publicKey: readValue('PUBLIC_KEY', ['MICPROBE_FREEMIUS_PUBLIC_KEY', 'FREEMIUS_PUBLIC_KEY']),
    sandboxToken: process.env.MICPROBE_FREEMIUS_SANDBOX_TOKEN || '',
    sandboxCtx: process.env.MICPROBE_FREEMIUS_SANDBOX_CTX || '',
    apiToken: readValue('API_TOKEN', ['MICPROBE_FREEMIUS_API_TOKEN', 'FREEMIUS_API_TOKEN'])
  };
}

const FREEMIUS_ENV = readFreemiusEnv(normalizeFreemiusMode(process.env.MICPROBE_FREEMIUS_MODE));
const legacyPremium = import('./server/legacy-premium.mjs');

function buildFreemiusCheckoutUrl(env) {
  const base = env.checkoutUrl || (env.productId && env.planId
    ? `https://checkout.freemius.com/product/${encodeURIComponent(env.productId)}/plan/${encodeURIComponent(env.planId)}/` : '');
  if (!base || env.mode !== 'sandbox') return base;
  try {
    const url = new URL(base);
    let token = env.sandboxToken;
    let ctx = env.sandboxCtx;
    if (!(token && ctx) && env.publicKey && env.productSecret && env.productId) {
      ctx = Math.floor(Date.now() / 1000).toString();
      token = crypto.createHash('md5').update(`${ctx}${env.productId}${env.productSecret}${env.publicKey}checkout`).digest('hex');
    }
    token ||= url.searchParams.get('sandbox');
    ctx ||= url.searchParams.get('s_ctx_ts');
    if (!/^[a-f0-9]{32}$/i.test(token || '') || !/^\d{9,13}$/.test(ctx || '')) return '';
    url.searchParams.set('sandbox', token);
    url.searchParams.set('s_ctx_ts', ctx);
    return url.toString();
  } catch { return ''; }
}

// Only the adapter owns Node SQLite. The actual account/billing rules also run
// in Workers against D1; no server modules enter the public asset directory.
let accountsRuntime;
async function getAccountsRuntime() {
  if (!accountsRuntime) {
    accountsRuntime = (async () => {
      const [{ createAccountService }, { createNodeAccountDb }, { createAccountBilling }] = await Promise.all([
        import('./server/account-service.mjs'), import('./server/node-account-db.mjs'), import('./server/account-billing.mjs')
      ]);
      const googleClientId = process.env.MICPROBE_GOOGLE_CLIENT_ID || '';
      const db = googleClientId ? createNodeAccountDb(process.env.MICPROBE_ACCOUNT_DB_PATH || path.join(__dirname, '.tmp', 'accounts.sqlite')) : null;
      const accounts = createAccountService({ db, googleClientId, mode: FREEMIUS_ENV.mode,
        origin: process.env.MICPROBE_PUBLIC_ORIGIN || undefined });
      const billing = createAccountBilling({ accounts, config: FREEMIUS_ENV, checkoutUrl: () => buildFreemiusCheckoutUrl(FREEMIUS_ENV),
        enabled: Boolean(db && googleClientId), evaluatePremiumReport });
      return { accounts, billing, enabled: Boolean(db && googleClientId) };
    })().catch(error => { accountsRuntime = null; throw error; });
  }
  return accountsRuntime;
}

async function handleAccountApi(req, res, url) {
  const runtime = await getAccountsRuntime();
  const options = { method: req.method, headers: req.headers };
  if (!['GET', 'HEAD'].includes(req.method)) { options.body = req; options.duplex = 'half'; }
  // A configured public origin is trusted deployment configuration. Forwarded
  // headers are not trusted to select a cookie domain or checkout return URL.
  const requestUrl = process.env.MICPROBE_PUBLIC_ORIGIN
    ? new URL(`${url.pathname}${url.search}`, new URL(process.env.MICPROBE_PUBLIC_ORIGIN).origin) : url;
  const request = new Request(requestUrl, options);
  const response = await runtime.billing.handle(request) || await runtime.accounts.handle(request);
  if (!response) return false;
  const headers = { ...SECURITY_HEADERS, ...Object.fromEntries(response.headers) };
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers['set-cookie'] = cookies;
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
  return true;
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

function getFreemiusConfigIssues(env) {
  const issues = [];
  if (!env.productId) issues.push('missing_product_id');
  if (!env.apiToken) issues.push('missing_api_token');
  if (env.mode === 'sandbox' && !buildFreemiusCheckoutUrl(env)) issues.push('sandbox_token_unavailable');
  if (!env.checkoutUrl && (!env.productId || !env.planId)) {
    issues.push('missing_checkout_target');
  }
  if (!env.productSecret) {
    issues.push('missing_product_secret');
  }
  if (env.mode === 'production') {
    if (!env.successUrl) {
      issues.push('missing_production_success_url');
    } else if (!isHttpsUrl(env.successUrl)) {
      issues.push('production_success_url_must_be_https');
    }
  }
  return issues;
}

function validateFreemiusRedirectParams(params) {
  const licenseId = params.get('license_id') || '';
  if (!licenseId) return 'missing_license_id';

  if (FREEMIUS_ENV.planId) {
    const planId = params.get('plan_id') || '';
    if (!planId) return 'missing_plan_id';
    if (planId !== FREEMIUS_ENV.planId) return 'plan_mismatch';
  }

  if (FREEMIUS_ENV.pricingId) {
    const pricingId = params.get('pricing_id') || '';
    if (!pricingId) return 'missing_pricing_id';
    if (pricingId !== FREEMIUS_ENV.pricingId) return 'pricing_mismatch';
  }

  // NOT: Freemius signed-redirect'e billing_cycle eklemez; dogrulama sarti yapilmaz
  // (worker/dev.js ile ayni gerekce). Yalnizca bilgi amacli entitlement'a yaziliyor.
  return null;
}

function buildHeaders(contentType) {
  const headers = { 'Content-Type': contentType, ...SECURITY_HEADERS };
  if (contentType.startsWith('text/html')) {
    headers['Content-Security-Policy'] = CSP_POLICY;
  }
  return headers;
}

const PUBLIC_FILES = new Set(['index.html', 'micprobe.html', 'privacy.html', 'terms.html']);
const PUBLIC_DIRECTORIES = new Set(['assets', 'css', 'js']);

function resolveStaticPath(requestPathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(requestPathname);
  } catch {
    return null;
  }
  // Backslashes and drive/stream syntax must not become Windows filesystem paths.
  if (/[\\:\u0000]/.test(decoded)) return null;
  const segments = decoded.split('/').filter(Boolean);
  if (segments.some(segment => segment.startsWith('.'))) return null;

  if (!PUBLIC_FILES.has(segments.join('/')) && !PUBLIC_DIRECTORIES.has(segments[0])) {
    // SPA routes resolve directly to the entry point, never to a private repo file.
    return path.extname(segments.at(-1) || '') ? null : path.join(__dirname, 'index.html');
  }

  const resolved = path.resolve(__dirname, ...segments);
  const relative = path.relative(__dirname, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return resolved;
}

// ============================================
// Statik dosya servisi: cache doğrulama + sıkıştırma
// ============================================

const COMPRESSION_MIN_BYTES = 1024;

// 0 (default) => no-cache: her istek ETag ile doğrulanır, değişmemişse gövdesiz 304 döner.
// >0 => max-age=N: dosya sürümleme olmadığı için kısa tutulmalı (dev'de taze içerik garantisi bozulur).
const STATIC_MAX_AGE_SECONDS = (() => {
  const fromEnv = Number.parseInt(process.env.MICPROBE_STATIC_MAX_AGE || '', 10);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 0;
})();

function cacheControlForStatic(contentType) {
  // HTML (SPA giriş noktası) daima revalidate edilir
  if (STATIC_MAX_AGE_SECONDS === 0 || contentType.startsWith('text/html')) return 'no-cache';
  return `public, max-age=${STATIC_MAX_AGE_SECONDS}, must-revalidate`;
}

function isCompressibleType(contentType) {
  return contentType.startsWith('text/')
    || contentType.startsWith('application/json')
    || contentType.startsWith('image/svg+xml');
}

function pickContentEncoding(req) {
  const acceptEncoding = String(req.headers['accept-encoding'] || '');
  if (/\bbr\b/.test(acceptEncoding)) return 'br';
  if (/\bgzip\b/.test(acceptEncoding)) return 'gzip';
  return null;
}

function compressContent(content, encoding, callback) {
  if (encoding === 'br') {
    // Brotli default quality (11) istek başına çok yavaş; 5, hız/oran dengesi için yeterli
    zlib.brotliCompress(content, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 5,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: content.length
      }
    }, callback);
    return;
  }
  zlib.gzip(content, callback);
}

function isRequestFresh(req, etag, lastModified) {
  const ifNoneMatch = req.headers['if-none-match'];
  if (ifNoneMatch) {
    return ifNoneMatch.split(',').some((value) => value.trim() === etag);
  }
  const ifModifiedSince = Date.parse(req.headers['if-modified-since'] || '');
  return Number.isFinite(ifModifiedSince) && Date.parse(lastModified) <= ifModifiedSince;
}

function serveStaticFile(req, res, filePath, contentType, allowSpaFallback) {
  fs.stat(filePath, (statErr, stats) => {
    if (statErr && statErr.code !== 'ENOENT') {
      res.writeHead(500, buildHeaders('text/plain; charset=utf-8'));
      res.end(`500 Internal Server Error\n${statErr.code || 'Unknown error'}`);
      return;
    }

    if (statErr || !stats.isFile()) {
      // SPA fallback: extension yoksa index.html döndür
      if (allowSpaFallback) {
        serveStaticFile(req, res, path.join(__dirname, 'index.html'), mimeTypes['.html'], false);
        return;
      }
      res.writeHead(404, buildHeaders('text/plain; charset=utf-8'));
      res.end('404 Not Found');
      return;
    }

    const etag = `W/"${stats.size.toString(16)}-${Math.round(stats.mtimeMs).toString(16)}"`;
    const lastModified = stats.mtime.toUTCString();
    const cacheControl = cacheControlForStatic(contentType);
    const compressible = isCompressibleType(contentType);

    if (isRequestFresh(req, etag, lastModified)) {
      res.writeHead(304, {
        ...SECURITY_HEADERS,
        'Cache-Control': cacheControl,
        'ETag': etag,
        'Last-Modified': lastModified,
        ...(compressible ? { 'Vary': 'Accept-Encoding' } : {})
      });
      res.end();
      return;
    }

    const headers = buildHeaders(contentType);
    headers['Cache-Control'] = cacheControl;
    headers['ETag'] = etag;
    headers['Last-Modified'] = lastModified;
    if (compressible) headers['Vary'] = 'Accept-Encoding';

    if (req.method === 'HEAD') {
      headers['Content-Length'] = stats.size;
      res.writeHead(200, headers);
      res.end();
      return;
    }

    fs.readFile(filePath, (readErr, content) => {
      if (readErr) {
        res.writeHead(500, buildHeaders('text/plain; charset=utf-8'));
        res.end(`500 Internal Server Error\n${readErr.code || 'Unknown error'}`);
        return;
      }

      const encoding = compressible && content.length >= COMPRESSION_MIN_BYTES
        ? pickContentEncoding(req)
        : null;

      if (!encoding) {
        headers['Content-Length'] = content.length;
        res.writeHead(200, headers);
        res.end(content);
        return;
      }

      compressContent(content, encoding, (zlibErr, compressed) => {
        // Sıkıştırma hata verir ya da kazanç sağlamazsa düz içerik gönderilir
        if (zlibErr || compressed.length >= content.length) {
          headers['Content-Length'] = content.length;
          res.writeHead(200, headers);
          res.end(content);
          return;
        }
        headers['Content-Encoding'] = encoding;
        headers['Content-Length'] = compressed.length;
        res.writeHead(200, headers);
        res.end(compressed);
      });
    });
  });
}

function writeJson(res, statusCode, payload) {
  const headers = buildHeaders('application/json; charset=utf-8');
  headers['Cache-Control'] = 'no-store';
  res.writeHead(statusCode, headers);
  res.end(JSON.stringify(payload));
}

function readJsonBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
        reject(new Error('payload_too_large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('invalid_json'));
      }
    });
    req.on('error', reject);
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

function handleFreemiusConfig(res) {
  const issues = getFreemiusConfigIssues(FREEMIUS_ENV);
  writeJson(res, 200, {
    configured: issues.length === 0,
    mode: FREEMIUS_ENV.mode,
    sandboxActive: FREEMIUS_ENV.mode === 'sandbox' ? Boolean(buildFreemiusCheckoutUrl(FREEMIUS_ENV)) : null,
    productId: FREEMIUS_ENV.productId,
    planId: FREEMIUS_ENV.planId,
    pricingId: FREEMIUS_ENV.pricingId,
    checkoutUrl: buildFreemiusCheckoutUrl(FREEMIUS_ENV),
    successUrl: FREEMIUS_ENV.successUrl,
    billingCycle: FREEMIUS_ENV.billingCycle,
    title: FREEMIUS_ENV.title,
    accountConfigured: Boolean(process.env.MICPROBE_GOOGLE_CLIENT_ID),
    issues
  });
}

async function handleFreemiusVerify(req, res, url) {
  if (!FREEMIUS_ENV.productSecret) {
    writeJson(res, 503, { ok: false, error: 'missing_product_secret' });
    return;
  }

  const rawUrl = url.searchParams.get('url');
  if (!rawUrl) {
    writeJson(res, 400, { ok: false, error: 'missing_url' });
    return;
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    writeJson(res, 400, { ok: false, error: 'invalid_url' });
    return;
  }

  const signature = parsed.searchParams.get('signature');
  if (!signature) {
    writeJson(res, 400, { ok: false, error: 'missing_signature' });
    return;
  }

  const cleanUrl = stripSignatureParam(rawUrl);
  const expected = crypto
    .createHmac('sha256', FREEMIUS_ENV.productSecret)
    .update(cleanUrl)
    .digest('hex');
  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(signature);

  if (signatureBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, signatureBuffer)) {
    writeJson(res, 401, { ok: false, error: 'invalid_signature' });
    return;
  }

  const params = parsed.searchParams;
  const validationError = validateFreemiusRedirectParams(params);
  if (validationError) {
    writeJson(res, 403, { ok: false, error: validationError });
    return;
  }

  try {
    const entitlement = await (await legacyPremium).createLegacyPremium(FREEMIUS_ENV).verifyPurchase(params);
    writeJson(res, 200, { ok: true, entitlement });
  } catch (error) { writeJson(res, error.status || 503, { ok: false, error: error.code || 'license_check_failed' }); }
}

async function handleDetailedReport(req, res) {
  if (!FREEMIUS_ENV.productSecret) {
    writeJson(res, 503, { ok: false, error: 'missing_product_secret' });
    return;
  }

  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (err) {
    writeJson(res, err.message === 'payload_too_large' ? 413 : 400, { ok: false, error: err.message });
    return;
  }

  const authHeader = req.headers.authorization || '';
  const headerToken = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
  let entitlement;
  try { entitlement = await (await legacyPremium).createLegacyPremium(FREEMIUS_ENV).authorize(headerToken || payload.entitlementToken); }
  catch (error) { writeJson(res, error.status || 503, { ok: false, error: error.code || 'invalid_entitlement' }); return; }

  if (!isDetailedReportInput(payload.report)) {
    writeJson(res, 400, { ok: false, error: 'missing_report' });
    return;
  }

  writeJson(res, 200, {
    ok: true,
    entitlement,
    detailed: evaluatePremiumReport(payload.report)
  });
}

const server = http.createServer(async (req, res) => {
  let pathname;
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    pathname = url.pathname;
    if (pathname === '/api/freemius/restore' && req.method === 'POST') {
      if (process.env.MICPROBE_GOOGLE_CLIENT_ID) { writeJson(res, 403, { ok: false, error: 'account_sign_in_required' }); return; }
      const { isAccountMutationAllowed } = await import('./server/account-service.mjs');
      if (!isAccountMutationAllowed(new Request(url, { headers: req.headers }), process.env.MICPROBE_PUBLIC_ORIGIN || url.origin)) {
        writeJson(res, 403, { ok: false, error: 'invalid_origin' }); return;
      }
      try {
        const { licenseKey } = await readJsonBody(req, 16384);
        const entitlement = await (await legacyPremium).createLegacyPremium(FREEMIUS_ENV).restore(licenseKey);
        writeJson(res, 200, { ok: true, entitlement });
      } catch (error) { writeJson(res, error.status || 400, { ok: false, error: error.code || 'invalid_license_key' }); }
      return;
    }

    if (pathname.startsWith('/api/account/') || pathname === '/api/freemius/webhook'
      || (pathname === '/api/report/detailed' && process.env.MICPROBE_GOOGLE_CLIENT_ID)) {
      try {
        if (await handleAccountApi(req, res, url)) return;
      } catch {
        writeJson(res, 503, { ok: false, error: 'account_service_unavailable' });
        return;
      }
      if (pathname.startsWith('/api/account/')) {
        writeJson(res, 404, { ok: false, error: 'not_found' });
        return;
      }
    }

    if (req.method === 'GET' && pathname === '/api/freemius/config') {
      handleFreemiusConfig(res);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/freemius/verify') {
      handleFreemiusVerify(req, res, url);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/report/detailed') {
      handleDetailedReport(req, res).catch((err) => {
        writeJson(res, 500, { ok: false, error: err.message || 'detailed_report_failed' });
      });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, buildHeaders('text/plain; charset=utf-8'));
      res.end('405 Method Not Allowed');
      return;
    }
  } catch {
    res.writeHead(400, buildHeaders('text/plain; charset=utf-8'));
    res.end('400 Bad Request');
    return;
  }

  if (pathname === '/') {
    pathname = '/index.html';
  }

  if (pathname === '/favicon.ico') {
    res.writeHead(204, SECURITY_HEADERS);
    res.end();
    return;
  }

  const filePath = resolveStaticPath(pathname);
  if (!filePath) {
    res.writeHead(403, buildHeaders('text/plain; charset=utf-8'));
    res.end('403 Forbidden');
    return;
  }

  const extname = String(path.extname(filePath)).toLowerCase();
  const contentType = mimeTypes[extname] || 'application/octet-stream';

  serveStaticFile(req, res, filePath, contentType, !extname);
});

function listenWithFallback(startPort, maxAttempts = 20) {
  let port = startPort;

  const onListening = () => {
    console.log(`Server running at http://localhost:${port}/`);
    if (port !== startPort) {
      console.warn(
        `NOTE: Port ${startPort} in use. http://localhost:${startPort}/ baska bir server olabilir (dizin listesi vb). Dogru adres: http://localhost:${port}/`
      );
    }
  };

  const tryListen = () => {
    server.removeListener('listening', onListening);
    server.once('listening', onListening);
    server.listen(port);
  };

  server.on('error', (err) => {
    if (!strictPort && err.code === 'EADDRINUSE' && port < startPort + maxAttempts) {
      console.warn(`Port ${port} in use, trying ${port + 1}...`);
      port += 1;
      tryListen();
      return;
    }

    if (strictPort && err.code === 'EADDRINUSE') {
      console.error(`Port ${port} in use. Strict port mode enabled; not trying another port.`);
    } else {
      console.error(err);
    }
    process.exitCode = 1;
  });

  tryListen();
}

if (require.main === module) listenWithFallback(basePort);

module.exports = { server };
