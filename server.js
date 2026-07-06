const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_PORT = 8080;
const basePort = (() => {
  const fromEnv = Number.parseInt(process.env.PORT || '', 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0 && fromEnv < 65536) return fromEnv;
  return DEFAULT_PORT;
})();

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

const FREEMIUS_ENV = {
  productId: process.env.MICPROBE_FREEMIUS_PRODUCT_ID || process.env.FREEMIUS_PRODUCT_ID || '',
  planId: process.env.MICPROBE_FREEMIUS_PLAN_ID || process.env.FREEMIUS_PLAN_ID || '',
  checkoutUrl: process.env.MICPROBE_FREEMIUS_CHECKOUT_URL || '',
  successUrl: process.env.MICPROBE_FREEMIUS_SUCCESS_URL || '',
  billingCycle: process.env.MICPROBE_FREEMIUS_BILLING_CYCLE || '',
  title: process.env.MICPROBE_FREEMIUS_CHECKOUT_TITLE || 'MicProbe Premium',
  productSecret: process.env.MICPROBE_FREEMIUS_PRODUCT_SECRET || process.env.FREEMIUS_PRODUCT_SECRET || ''
};

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
  writeJson(res, 200, {
    configured: Boolean(FREEMIUS_ENV.checkoutUrl || (FREEMIUS_ENV.productId && FREEMIUS_ENV.planId)),
    productId: FREEMIUS_ENV.productId,
    planId: FREEMIUS_ENV.planId,
    checkoutUrl: FREEMIUS_ENV.checkoutUrl,
    successUrl: FREEMIUS_ENV.successUrl,
    billingCycle: FREEMIUS_ENV.billingCycle,
    title: FREEMIUS_ENV.title
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
  writeJson(res, 200, {
    ok: true,
    entitlement: {
      action: params.get('action') || '',
      email: params.get('email') || '',
      userId: params.get('user_id') || '',
      planId: params.get('plan_id') || '',
      pricingId: params.get('pricing_id') || '',
      paymentId: params.get('payment_id') || '',
      subscriptionId: params.get('subscription_id') || '',
      licenseId: params.get('license_id') || '',
      billingCycle: params.get('billing_cycle') || '',
      currency: params.get('currency') || '',
      amount: params.get('amount') || '',
      expiration: params.get('expiration') || '',
      trialEndsAt: params.get('trial_ends_at') || ''
    }
  });
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, buildHeaders('text/plain; charset=utf-8'));
    res.end('405 Method Not Allowed');
    return;
  }

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
    if (err.code === 'EADDRINUSE' && port < startPort + maxAttempts) {
      console.warn(`Port ${port} in use, trying ${port + 1}...`);
      port += 1;
      tryListen();
      return;
    }

    console.error(err);
    process.exitCode = 1;
  });

  tryListen();
}

listenWithFallback(basePort);
