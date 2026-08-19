import { createGenLayerRpcProxyMiddleware } from '../market/genlayer-rpc-proxy.js';
import {
  normalizeFunctionPath,
  notFound,
  requireSameOrigin,
  vercelClientKey,
} from '../server/vercel-runtime.mjs';

const middleware = createGenLayerRpcProxyMiddleware({
  upstreamUrl: process.env.GENLAYER_RPC_URL || 'https://studio.genlayer.com/api',
  clientKey: vercelClientKey,
});

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res, { allowMetaMask: true })) return;
  normalizeFunctionPath(req, '/genlayer-rpc');
  await middleware(req, res, () => notFound(res));
}
