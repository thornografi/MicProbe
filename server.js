const http = require('http');
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
  "style-src 'self' 'unsafe-inline'",
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
