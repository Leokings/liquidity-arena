import { createClient } from 'genlayer-js';
import { studionet } from 'genlayer-js/chains';

import { configuredBinanceRestBases } from '../market/binance-proxy.js';
import { loadLiquidityArenaDeploymentConfig } from '../server/deployment-config.mjs';
import {
  READINESS_TIMEOUT_MS,
  createLiquidityArenaReadinessProbe,
  readinessEpochEnds,
} from '../server/readiness.mjs';

function json(res, statusCode, body, method = 'GET') {
  res.statusCode = statusCode;
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-type', 'application/json; charset=utf-8');
  if (method === 'HEAD') res.end();
  else res.end(JSON.stringify(body));
}

export { readinessEpochEnds };

export function createReadyHandler({
  environment = process.env,
  createClientImpl = createClient,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  timeoutMs = READINESS_TIMEOUT_MS,
} = {}) {
  const deployment = loadLiquidityArenaDeploymentConfig(environment);
  const config = Object.freeze({
    ...deployment,
    binanceRestBases: configuredBinanceRestBases(environment.BINANCE_REST_BASES),
  });
  const client = createClientImpl({ chain: studionet, endpoint: config.genLayerRpcUrl });
  const readiness = createLiquidityArenaReadinessProbe({
    config,
    fetchImpl,
    now,
    timeoutMs,
    readContract: ({ address, functionName, args }) => client.readContract({
      address,
      functionName,
      args,
    }),
  });

  return async function readyHandler(req, res) {
    const method = String(req.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      res.setHeader('allow', 'GET, HEAD');
      json(res, 405, { error: 'Method not allowed.' }, method);
      return;
    }
    const payload = await readiness.probe();
    json(res, payload.status === 'ready' ? 200 : 503, payload, method);
  };
}

let productionHandler;

export default async function handler(req, res) {
  try {
    productionHandler ||= createReadyHandler();
    await productionHandler(req, res);
  } catch {
    json(res, 503, {
      status: 'degraded',
      service: 'liquidity-arena',
      checks: { configuration: { ready: false } },
    }, String(req.method || 'GET').toUpperCase());
  }
}
