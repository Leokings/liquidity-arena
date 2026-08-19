const METAMASK_ORIGIN = 'chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn';

function firstHeaderValue(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  return String(raw || '').split(',')[0].trim();
}
export function vercelClientKey(req) {
  return firstHeaderValue(
    req?.headers?.['x-vercel-forwarded-for']
      || req?.headers?.['x-forwarded-for']
      || req?.socket?.remoteAddress,
  ).slice(0, 256) || 'unknown';
}

export function requireSameOrigin(req, res, { allowMetaMask = false } = {}) {
  const rawOrigin = firstHeaderValue(req?.headers?.origin);
  if (!rawOrigin) return true;
  if (allowMetaMask && rawOrigin.toLowerCase() === METAMASK_ORIGIN) return true;

  let origin;
  try {
    origin = new URL(rawOrigin);
  } catch {
    res.statusCode = 403;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Cross-origin API access is not allowed.' }));
    return false;
  }

  const forwardedHost = firstHeaderValue(req?.headers?.['x-forwarded-host']);
  const host = (forwardedHost || firstHeaderValue(req?.headers?.host)).toLowerCase();
  if (host && origin.host.toLowerCase() === host) return true;

  res.statusCode = 403;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ error: 'Cross-origin API access is not allowed.' }));
  return false;
}

export function notFound(res) {
  if (res.writableEnded) return;
  res.statusCode = 404;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ error: 'Route not found.' }));
}

export function normalizeFunctionPath(req, pathname) {
  const requestUrl = new URL(req.url || '/', 'http://localhost');
  requestUrl.pathname = pathname;
  req.url = `${requestUrl.pathname}${requestUrl.search}`;
}
