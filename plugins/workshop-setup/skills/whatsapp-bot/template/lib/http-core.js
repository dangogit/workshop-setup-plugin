const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function requestAccessError(req, { expectedToken, port }) {
  const address = req.socket?.remoteAddress || '';
  const loopback = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
  if (!loopback) return { status: 403, code: 'local_only' };

  const host = String(req.headers.host || '').toLowerCase();
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!allowedHosts.has(host)) return { status: 403, code: 'invalid_host' };

  const method = String(req.method || 'GET').toUpperCase();
  if (!SAFE_METHODS.has(method)) {
    const origin = req.headers.origin;
    if (origin) {
      let originHost = '';
      try { originHost = new URL(origin).host.toLowerCase(); } catch (_) {}
      if (!allowedHosts.has(originHost)) return { status: 403, code: 'invalid_origin' };
    }
    if (req.headers['x-wa-bot-token'] !== expectedToken) {
      return { status: 403, code: 'invalid_ui_token' };
    }
  }
  return null;
}

export function readBody(req, maxBytes = 128 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '', size = 0, finished = false;
    req.on('data', chunk => {
      if (finished) return;
      size += chunk.length;
      if (size > maxBytes) {
        finished = true;
        const error = new Error('request_too_large');
        error.statusCode = 413;
        reject(error);
        req.resume();
        return;
      }
      data += chunk;
    });
    req.on('end', () => { if (!finished) resolve(data); });
    req.on('error', error => { if (!finished) reject(error); });
  });
}

export function persistThenApply(nextConfig, { persist, apply }) {
  persist(nextConfig);
  apply(nextConfig);
  return nextConfig;
}
