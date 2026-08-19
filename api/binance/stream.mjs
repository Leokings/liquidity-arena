import {
  DEFAULT_MAX_SSE_CLIENTS_PER_IP,
  createBinanceStreamMiddleware,
} from '../../market/binance-stream.js';
import {
  normalizeFunctionPath,
  notFound,
  requireSameOrigin,
  vercelClientKey,
} from '../../server/vercel-runtime.mjs';

// A warm Vercel function instance shares one outbound exchange connection.
// The browser's existing EventSource retry logic reconnects when Vercel
// recycles the function instance or reaches its bounded execution duration.
const middleware = createBinanceStreamMiddleware({
  maxClientsPerIp: DEFAULT_MAX_SSE_CLIENTS_PER_IP,
  resolveClientIp: vercelClientKey,
  // End normally before Vercel's 300-second function ceiling. EventSource
  // reconnects after the advertised one-second retry without surfacing a
  // platform timeout as an application error.
  sseLifetimeMs: 285_000,
});

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  normalizeFunctionPath(req, '/api/binance/stream');
  await middleware(req, res, () => notFound(res));
}
