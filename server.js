const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { evaluatePremiumReport } = require('./server/premium-report-evaluator');

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
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data:",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "connect-src 'self'"
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

loadLocalEnvFile('.env.local');
loadLocalEnvFile('.env');

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
    productSecret: readValue('PRODUCT_SECRET', ['MICPROBE_FREEMIUS_PRODUCT_SECRET', 'FREEMIUS_PRODUCT_SECRET'])
  };
}

const FREEMIUS_ENV = readFreemiusEnv(normalizeFreemiusMode(process.env.MICPROBE_FREEMIUS_MODE));

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

function safeJoin(baseDir, requestPathname) {
  const normalized = path
    .normalize(requestPathname)
    .replace(/^(\.\.[/\\])+/, '')
    .replace(/^[/\\]+/, '');

  const joined = path.join(baseDir, normalized);
  const resolvedBase = path.resolve(baseDir);
  const resolvedJoined = path.resolve(joined);
  if (!resolvedJoined.startsWith(resolvedBase)) {
    return null;
  }

  return resolvedJoined;
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

function base64UrlEncode(value) {
  return Buffer.from(value).toString('base64url');
}

function base64UrlDecode(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function signValue(value) {
  return crypto
    .createHmac('sha256', FREEMIUS_ENV.productSecret)
    .update(value)
    .digest('base64url');
}

function createEntitlementToken(entitlement) {
  const payload = {
    v: 1,
    mode: entitlement.mode,
    planId: entitlement.planId,
    pricingId: entitlement.pricingId,
    billingCycle: entitlement.billingCycle,
    expiresAt: entitlement.expiration || entitlement.trialEndsAt || '',
    iat: Date.now()
  };
  const encoded = base64UrlEncode(JSON.stringify(payload));
  return `${encoded}.${signValue(encoded)}`;
}

function verifyEntitlementToken(token) {
  if (!FREEMIUS_ENV.productSecret || !token || typeof token !== 'string') return null;
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) return null;

  const expected = signValue(encoded);
  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(signature);
  if (signatureBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, signatureBuffer)) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(encoded));
  } catch {
    return null;
  }

  if (payload.v !== 1) return null;
  if (payload.mode !== FREEMIUS_ENV.mode) return null;
  if (FREEMIUS_ENV.planId && payload.planId !== FREEMIUS_ENV.planId) return null;
  if (FREEMIUS_ENV.pricingId && payload.pricingId !== FREEMIUS_ENV.pricingId) return null;
  // billing_cycle bilerek dogrulanmiyor (bkz. validateFreemiusRedirectParams notu).

  if (payload.expiresAt) {
    const expiresAt = Date.parse(String(payload.expiresAt).replace(' ', 'T'));
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) return null;
  }

  return payload;
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
    productId: FREEMIUS_ENV.productId,
    planId: FREEMIUS_ENV.planId,
    pricingId: FREEMIUS_ENV.pricingId,
    checkoutUrl: FREEMIUS_ENV.checkoutUrl,
    successUrl: FREEMIUS_ENV.successUrl,
    billingCycle: FREEMIUS_ENV.billingCycle,
    title: FREEMIUS_ENV.title,
    issues
  });
}

function handleFreemiusVerify(req, res, url) {
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

  const entitlement = {
    mode: FREEMIUS_ENV.mode,
    action: params.get('action') || '',
    planId: params.get('plan_id') || '',
    pricingId: params.get('pricing_id') || '',
    billingCycle: params.get('billing_cycle') || '',
    expiration: params.get('expiration') || '',
    trialEndsAt: params.get('trial_ends_at') || ''
  };

  writeJson(res, 200, {
    ok: true,
    entitlement: {
      ...entitlement,
      accessToken: createEntitlementToken(entitlement)
    }
  });
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
  const entitlement = verifyEntitlementToken(headerToken || payload.entitlementToken);
  if (!entitlement) {
    writeJson(res, 403, { ok: false, error: 'invalid_entitlement' });
    return;
  }

  if (!payload.report?.audioMetrics) {
    writeJson(res, 400, { ok: false, error: 'missing_report' });
    return;
  }

  writeJson(res, 200, {
    ok: true,
    detailed: evaluatePremiumReport(payload.report)
  });
}

const server = http.createServer((req, res) => {
  let pathname;
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    pathname = url.pathname;

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

  const filePath = safeJoin(__dirname, pathname);
  if (!filePath) {
    res.writeHead(403, buildHeaders('text/plain; charset=utf-8'));
    res.end('403 Forbidden');
    return;
  }

  const extname = String(path.extname(filePath)).toLowerCase();
  const contentType = mimeTypes[extname] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        // SPA fallback: extension yoksa index.html döndür
        if (!extname) {
          const indexPath = path.join(__dirname, 'index.html');
          fs.readFile(indexPath, (indexErr, indexContent) => {
            if (indexErr) {
              res.writeHead(404, buildHeaders('text/plain; charset=utf-8'));
              res.end('404 Not Found');
              return;
            }
            res.writeHead(200, buildHeaders('text/html; charset=utf-8'));
            if (req.method === 'HEAD') {
              res.end();
              return;
            }
            res.end(indexContent);
          });
          return;
        }
        res.writeHead(404, buildHeaders('text/plain; charset=utf-8'));
        res.end('404 Not Found');
        return;
      }
      res.writeHead(500, buildHeaders('text/plain; charset=utf-8'));
      res.end(`500 Internal Server Error\n${err.code || 'Unknown error'}`);
      return;
    }

    res.writeHead(200, buildHeaders(contentType));
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.end(content);
  });
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

listenWithFallback(basePort);
