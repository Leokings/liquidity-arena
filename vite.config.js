import { resolve } from 'node:path';
import { defineConfig, loadEnv } from 'vite';

import { binanceProxyPlugin } from './market/binance-proxy.js';
import { binanceStreamPlugin } from './market/binance-stream.js';
import { genLayerRpcProxyPlugin } from './market/genlayer-rpc-proxy.js';

// Liquidity Arena keeps public market data and wallet RPC calls
// same-origin in local development and production.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, '');

  return {
    plugins: [
      genLayerRpcProxyPlugin({
        upstreamUrl: env.GENLAYER_RPC_URL || 'https://studio.genlayer.com/api',
      }),
      // The exact stream route must be registered before the broader REST
      // proxy, which intentionally rejects unknown /api/binance/* paths.
      binanceStreamPlugin(),
      binanceProxyPlugin({
        // Optional comma-separated subset of the proxy's fixed Binance
        // allowlist. It remains server-side and never enters the bundle.
        upstreamBases: env.BINANCE_REST_BASES || undefined,
      }),
    ],
    build: {
      rollupOptions: {
        input: {
          market: resolve(__dirname, 'market.html'),
        },
      },
    },
    optimizeDeps: { include: ['genlayer-js'] },
    server: {
      host: true,
      port: 4400,
      strictPort: true,
    },
  };
});
