import {
  configuredBinanceRestBases,
  createBinanceProxyMiddleware,
} from '../../market/binance-proxy.js';
import {
  normalizeFunctionPath,
  notFound,
  requireSameOrigin,
  vercelClientKey,
} from '../../server/vercel-runtime.mjs';

const upstreamBases = process.env.BINANCE_REST_BASES
  ? configuredBinanceRestBases(process.env.BINANCE_REST_BASES)
  : undefined;
const middleware = createBinanceProxyMiddleware({
  clientKey: vercelClientKey,
  upstreamBases,
});

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  normalizeFunctionPath(req, '/api/binance/klines');
  await middleware(req, res, () => notFound(res));
}
