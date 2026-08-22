import { createReadStream, realpathSync, statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';

import { createClient } from 'genlayer-js';
import { testnetBradbury } from 'genlayer-js/chains';

import {
  configuredBinanceRestBases,
  createBinanceProxyMiddleware,
} from '../market/binance-proxy.js';
import {
  DEFAULT_MAX_SSE_CLIENTS_PER_IP,
  createBinanceStreamMiddleware,
} from '../market/binance-stream.js';
import { createGenLayerRpcProxyMiddleware } from '../market/genlayer-rpc-proxy.js';
import {
  assertLiquidityArenaDeploymentConfig,
  loadLiquidityArenaDeploymentConfig,
} from './deployment-config.mjs';
import {
  READINESS_CACHE_MS,
  READINESS_TIMEOUT_MS,
  createLiquidityArenaReadinessProbe,
} from './readiness.mjs';

const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_PORT = 4400;
const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_HEADERS_TIMEOUT_MS = 15_000;
const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 5_000;
const DEFAULT_READINESS_TIMEOUT_MS = READINESS_TIMEOUT_MS;
const DEFAULT_READINESS_CACHE_MS = READINESS_CACHE_MS;

function canonicalChainId(chain) {
  const chainId = Number(chain?.id);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error('The GenLayer SDK returned an invalid built-in chain descriptor.');
  }
  return `0x${chainId.toString(16)}`;
}

function canonicalChainRpcUrl(chain) {
  const value = chain?.rpcUrls?.default?.http?.[0];
  if (!value) throw new Error('The GenLayer SDK built-in chain descriptor has no RPC URL.');
  return new URL(value).href;
}

const GENLAYER_NETWORKS = Object.freeze({
  'testnet-bradbury': Object.freeze({
    chain: testnetBradbury,
    chainId: canonicalChainId(testnetBradbury),
    rpcUrl: canonicalChainRpcUrl(testnetBradbury),
  }),
});

function configuredGenLayerNetwork(value) {
  const name = String(value || '').trim();
  const descriptor = GENLAYER_NETWORKS[name];
  if (!descriptor) {
    throw new Error('VITE_GENLAYER_NETWORK must be "testnet-bradbury".');
  }
  return Object.freeze({ name, ...descriptor });
}

function contentSecurityPolicy(genLayerRpcUrl) {
  const rpcOrigin = new URL(validatedUpstreamUrl(genLayerRpcUrl)).origin;
  return [
  "default-src 'self'",
  "base-uri 'none'",
  // Read-only GenLayer SDK calls use the selected built-in network endpoint;
  // Binance and wallet-adapter traffic stay same-origin.
  `connect-src 'self' ${rpcOrigin}`,
  "font-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "object-src 'none'",
  "script-src 'self'",
  // The market renders asset-specific CSS custom properties on elements. Keep
  // inline scripts forbidden while allowing those narrowly scoped styles.
  "style-src 'self' 'unsafe-inline'",
  "worker-src 'self'",
  ].join('; ');
}

const STATIC_CONTENT_SECURITY_POLICY = contentSecurityPolicy(
  GENLAYER_NETWORKS['testnet-bradbury'].rpcUrl,
);
const DEFAULT_WALLET_ORIGINS = Object.freeze([
  'chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn',
]);

const CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.woff2', 'font/woff2'],
]);

function integerEnvironmentValue(environment, name, fallback, { minimum, maximum }) {
  const raw = String(environment?.[name] ?? '').trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function validatedUpstreamUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('GENLAYER_RPC_URL must be an absolute HTTPS URL.');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('GENLAYER_RPC_URL must be an absolute HTTPS URL without embedded credentials.');
  }
  return url.href;
}

function validatedContractAddress(value) {
  const address = String(value || '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address) || /^0x0{40}$/i.test(address)) {
    throw new Error('VITE_GENLAYER_CONTRACT must be a non-zero 20-byte hex address.');
  }
  return address;
}

function configuredOrigins(value) {
  const entries = String(value || '')
    .split(',')
    .map((entry) => entry.trim().replace(/\/$/, ''))
    .filter(Boolean);
  return Object.freeze(entries.length > 0 ? entries : [...DEFAULT_WALLET_ORIGINS]);
}

function normalizedIpAddress(value) {
  let address = String(value || '').trim().toLowerCase();
  if (address.startsWith('::ffff:') && isIP(address.slice(7)) === 4) address = address.slice(7);
  return isIP(address) ? address : '';
}

function configuredTrustedProxyAddresses(value) {
  const addresses = String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const address = normalizedIpAddress(entry);
      if (!address) {
        throw new Error('TRUSTED_PROXY_ADDRESSES must contain only comma-separated IP addresses.');
      }
      return address;
    });
  return Object.freeze([...new Set(addresses)]);
}

/**
 * Resolve a quota key without trusting user-controlled forwarding headers by
 * default. X-Forwarded-For is consulted only when the direct peer is an
 * explicitly configured proxy, then the first untrusted hop is selected from
 * right to left.
 */
export function createClientIpResolver(trustedProxyAddresses = []) {
  const trusted = new Set(
    [...trustedProxyAddresses]
      .map(normalizedIpAddress)
      .filter(Boolean),
  );
  return function resolveClientIp(req) {
    const directAddress = normalizedIpAddress(req?.socket?.remoteAddress);
    if (!directAddress || !trusted.has(directAddress)) return directAddress || 'unknown';

    const rawHeader = Array.isArray(req?.headers?.['x-forwarded-for'])
      ? req.headers['x-forwarded-for'].join(',')
      : String(req?.headers?.['x-forwarded-for'] || '');
    if (!rawHeader || rawHeader.length > 4_096) return directAddress;
    const forwarded = rawHeader.split(',').map(normalizedIpAddress);
    if (forwarded.length > 32 || forwarded.some((address) => !address)) return directAddress;

    const chain = [...forwarded, directAddress];
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      if (!trusted.has(chain[index])) return chain[index];
    }
    return chain[0];
  };
}

export function loadServerConfig(environment = process.env, { cwd = process.cwd() } = {}) {
  const distValue = String(environment?.DIST_DIR || '').trim() || 'dist';
  const distDir = isAbsolute(distValue) ? resolve(distValue) : resolve(cwd, distValue);
  const network = configuredGenLayerNetwork(environment?.VITE_GENLAYER_NETWORK);
  const deployment = loadLiquidityArenaDeploymentConfig(environment, {
    defaultRpcUrl: network.rpcUrl,
  });
  return Object.freeze({
    host: String(environment?.HOST || DEFAULT_HOST).trim() || DEFAULT_HOST,
    port: integerEnvironmentValue(environment, 'PORT', DEFAULT_PORT, { minimum: 1, maximum: 65_535 }),
    shutdownGraceMs: integerEnvironmentValue(
      environment,
      'SHUTDOWN_GRACE_MS',
      DEFAULT_SHUTDOWN_GRACE_MS,
      { minimum: 0, maximum: 60_000 },
    ),
    distDir,
    ...deployment,
    walletOrigins: configuredOrigins(environment?.WALLET_ORIGINS),
    // This remains a fixed Binance-only allowlist, even when an operator
    // changes the preferred failover order in their deployment environment.
    binanceRestBases: configuredBinanceRestBases(environment?.BINANCE_REST_BASES),
    sseMaxClientsPerIp: integerEnvironmentValue(
      environment,
      'SSE_MAX_CLIENTS_PER_IP',
      DEFAULT_MAX_SSE_CLIENTS_PER_IP,
      { minimum: 1, maximum: 100 },
    ),
    trustedProxyAddresses: configuredTrustedProxyAddresses(environment?.TRUSTED_PROXY_ADDRESSES),
  });
}

function assertResolvedConfig(config) {
  if (!config || typeof config !== 'object') {
    throw new TypeError('Production server configuration is required.');
  }
  const network = configuredGenLayerNetwork(config.genLayerNetwork);
  assertLiquidityArenaDeploymentConfig(config);
  if (String(config.genLayerChainId || '').toLowerCase() !== network.chainId) {
    throw new Error('Configured GenLayer chain ID does not match VITE_GENLAYER_NETWORK.');
  }
  if (!String(config.distDir || '').trim()) {
    throw new Error('DIST_DIR is required by the production server.');
  }
  validatedContractAddress(config.contractAddress);
  configuredBinanceRestBases(config.binanceRestBases);
  if (config.sseMaxClientsPerIp !== undefined
    && (!Number.isSafeInteger(config.sseMaxClientsPerIp)
      || config.sseMaxClientsPerIp < 1
      || config.sseMaxClientsPerIp > 100)) {
    throw new Error('SSE_MAX_CLIENTS_PER_IP must be an integer between 1 and 100.');
  }
}

function createDefaultContractAccess(config) {
  const network = configuredGenLayerNetwork(config.genLayerNetwork);
  const client = createClient({
    chain: network.chain,
    endpoint: config.genLayerRpcUrl,
  });
  return Object.freeze({
    readContract: ({ address, functionName, args }) => client.readContract({
      address,
      functionName,
      args,
    }),
    readSchema: (address) => client.getContractSchema(address),
  });
}

function json(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.end(JSON.stringify(payload));
}

function text(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.end(body);
}

function insideRoot(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === '' || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot));
}

function verifiedDistRoot(distDir) {
  let details;
  try {
    details = statSync(distDir);
  } catch {
    throw new Error(`Production build directory does not exist: ${distDir}. Run npm run build first.`);
  }
  if (!details.isDirectory()) {
    throw new Error(`Production build path is not a directory: ${distDir}.`);
  }
  return realpathSync(distDir);
}

async function resolveStaticFile(distRoot, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { error: 400 };
  }
  if (decoded.includes('\0')) return { error: 400 };

  const relativePath = decoded === '/' ? 'market.html' : decoded.replace(/^\/+/, '');
  let candidate = resolve(distRoot, relativePath);
  if (!insideRoot(distRoot, candidate)) return { error: 403 };

  try {
    let details = await stat(candidate);
    if (details.isDirectory()) {
      candidate = resolve(candidate, 'index.html');
      if (!insideRoot(distRoot, candidate)) return { error: 403 };
      details = await stat(candidate);
    }
    if (!details.isFile()) return { error: 404 };
    const realCandidate = realpathSync(candidate);
    if (!insideRoot(distRoot, realCandidate)) return { error: 403 };
    return { path: realCandidate, size: details.size };
  } catch {
    return { error: 404 };
  }
}

async function serveStatic(req, res, distRoot, securityPolicy) {
  res.setHeader('content-security-policy', securityPolicy);
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('permissions-policy', 'camera=(), geolocation=(), microphone=(), payment=(), usb=()');
  res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
  res.setHeader('x-content-type-options', 'nosniff');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('allow', 'GET, HEAD');
    text(res, 405, 'Method not allowed.');
    return;
  }

  const requestUrl = new URL(req.url || '/', 'http://localhost');
  const file = await resolveStaticFile(distRoot, requestUrl.pathname);
  if (!file.path) {
    text(res, file.error, file.error === 400 ? 'Malformed path.' : 'Not found.');
    return;
  }

  const extension = extname(file.path).toLowerCase();
  res.statusCode = 200;
  res.setHeader('content-type', CONTENT_TYPES.get(extension) || 'application/octet-stream');
  res.setHeader('content-length', String(file.size));
  res.setHeader(
    'cache-control',
    requestUrl.pathname.startsWith('/assets/')
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
  );
  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  await new Promise((resolveStream, rejectStream) => {
    const stream = createReadStream(file.path);
    stream.once('error', rejectStream);
    res.once('close', resolveStream);
    res.once('finish', resolveStream);
    stream.pipe(res);
  });
}

function compose(middlewares, terminal) {
  return function dispatch(req, res) {
    const run = (index) => {
      if (res.writableEnded) return undefined;
      const middleware = middlewares[index];
      if (!middleware) return terminal(req, res);
      return middleware(req, res, () => run(index + 1));
    };
    return Promise.resolve(run(0));
  };
}

function normalizedOrigin(value) {
  try {
    const parsed = new URL(String(value || ''));
    return `${parsed.protocol}//${parsed.host}`.toLowerCase();
  } catch {
    return '';
  }
}

function createApiOriginMiddleware(walletOrigins = DEFAULT_WALLET_ORIGINS) {
  const allowedWalletOrigins = new Set(walletOrigins.map(normalizedOrigin).filter(Boolean));
  return function apiOriginGuard(req, res, next) {
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const isBinanceRoute = requestUrl.pathname.startsWith('/api/binance/');
    const isWalletRoute = requestUrl.pathname === '/genlayer-rpc';
    if (!isBinanceRoute && !isWalletRoute) return next();

    const rawOrigin = String(req.headers?.origin || '').trim();
    if (!rawOrigin) return next();
    const origin = normalizedOrigin(rawOrigin);
    const host = String(req.headers?.host || '').trim().toLowerCase();
    const sameHost = origin.startsWith('http://') || origin.startsWith('https://')
      ? new URL(origin).host.toLowerCase() === host
      : false;
    const walletExtension = isWalletRoute && allowedWalletOrigins.has(origin);
    if (sameHost || walletExtension) return next();

    json(res, 403, { status: 'error', error: 'Cross-origin API access is not allowed.' });
    return undefined;
  };
}

export function createProductionApp({
  config,
  fetchImpl = globalThis.fetch,
  webSocketFactory,
  streamHub,
  contractReader,
  schemaReader,
  logger = console,
} = {}) {
  assertResolvedConfig(config);
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');
  const distRoot = verifiedDistRoot(config.distDir);
  const securityPolicy = contentSecurityPolicy(config.genLayerRpcUrl);
  const resolveClientIp = createClientIpResolver(config.trustedProxyAddresses || []);

  const binanceStream = createBinanceStreamMiddleware({
    ...(streamHub ? { hub: streamHub } : {}),
    maxClientsPerIp: config.sseMaxClientsPerIp || DEFAULT_MAX_SSE_CLIENTS_PER_IP,
    resolveClientIp,
    ...(webSocketFactory ? { webSocketFactory } : {}),
    onError(error) {
      logger?.error?.(`[binance-stream] ${error?.message || 'Unknown stream error'}`);
    },
  });
  const defaultContractAccess = contractReader && schemaReader
    ? null
    : createDefaultContractAccess(config);
  const readiness = createLiquidityArenaReadinessProbe({
    config,
    fetchImpl,
    readContract: contractReader || defaultContractAccess.readContract,
    readSchema: schemaReader || defaultContractAccess.readSchema,
  });
  const middlewares = [
    createApiOriginMiddleware(config.walletOrigins || DEFAULT_WALLET_ORIGINS),
    createGenLayerRpcProxyMiddleware({
      fetchImpl,
      upstreamUrl: config.genLayerRpcUrl,
      clientKey: resolveClientIp,
    }),
    binanceStream,
    createBinanceProxyMiddleware({
      fetchImpl,
      clientKey: resolveClientIp,
      upstreamBases: config.binanceRestBases,
    }),
  ];

  const terminal = async (req, res) => {
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    if (requestUrl.pathname === '/healthz' || requestUrl.pathname === '/readyz') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('allow', 'GET, HEAD');
        json(res, 405, { status: 'error', error: 'Method not allowed.' });
        return;
      }
      const isReadiness = requestUrl.pathname === '/readyz';
      const payload = isReadiness ? await readiness.probe() : {
        status: 'ok',
        service: 'liquidity-arena',
        check: 'liveness',
        static: {
          ready: true,
          network: 'testnet-bradbury',
          chainId: 4_221,
          deployment: 'v8',
        },
        binance: {
          configured: binanceStream.hub.configured === true,
          streamRunning: binanceStream.hub.running === true,
          clients: Number(binanceStream.hub.clientCount || 0),
        },
        genlayerRpc: { configured: true },
        contract: { configured: true },
      };
      const statusCode = isReadiness && payload.status !== 'ready' ? 503 : 200;
      if (req.method === 'HEAD') {
        res.statusCode = statusCode;
        res.setHeader('cache-control', 'no-store');
        res.end();
      } else {
        json(res, statusCode, payload);
      }
      return;
    }
    await serveStatic(req, res, distRoot, securityPolicy);
  };

  const dispatch = compose(middlewares, terminal);
  let destroyed = false;
  return Object.freeze({
    config,
    streamHub: binanceStream.hub,
    async handler(req, res) {
      try {
        await dispatch(req, res);
      } catch (error) {
        logger?.error?.(`[server] ${error?.message || 'Unhandled request error'}`);
        if (!res.headersSent) json(res, 500, { status: 'error', error: 'Internal server error.' });
        else res.destroy?.();
      }
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      readiness.destroy();
      binanceStream.hub.destroy?.();
    },
  });
}

export async function startProductionServer({
  config = loadServerConfig(),
  host = config.host,
  port = config.port,
  fetchImpl,
  webSocketFactory,
  streamHub,
  contractReader,
  schemaReader,
  logger = console,
} = {}) {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new RangeError('Server port must be an integer between 0 and 65535.');
  }
  if (!String(host || '').trim()) throw new TypeError('Server host is required.');
  const app = createProductionApp({
    config,
    fetchImpl,
    webSocketFactory,
    streamHub,
    contractReader,
    schemaReader,
    logger,
  });
  const server = createServer((req, res) => {
    void app.handler(req, res);
  });
  server.requestTimeout = DEFAULT_REQUEST_TIMEOUT_MS;
  server.headersTimeout = DEFAULT_HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = DEFAULT_KEEP_ALIVE_TIMEOUT_MS;
  server.maxHeadersCount = 100;
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  try {
    await new Promise((resolveListen, rejectListen) => {
      const onError = (error) => {
        server.off('listening', onListening);
        rejectListen(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolveListen();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
  } catch (error) {
    app.destroy();
    throw error;
  }

  let closePromise = null;
  const close = ({ graceMs = config.shutdownGraceMs } = {}) => {
    if (closePromise) return closePromise;
    app.destroy();
    closePromise = new Promise((resolveClose, rejectClose) => {
      let forced = false;
      const forceTimer = setTimeout(() => {
        forced = true;
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections?.();
      }, Math.max(0, graceMs));
      forceTimer.unref?.();
      server.close((error) => {
        clearTimeout(forceTimer);
        if (error) rejectClose(error);
        else resolveClose({ forced });
      });
      server.closeIdleConnections?.();
    });
    return closePromise;
  };

  return Object.freeze({ app, server, close });
}

export {
  DEFAULT_HEADERS_TIMEOUT_MS,
  DEFAULT_HOST,
  DEFAULT_KEEP_ALIVE_TIMEOUT_MS,
  DEFAULT_PORT,
  DEFAULT_READINESS_CACHE_MS,
  DEFAULT_READINESS_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_SHUTDOWN_GRACE_MS,
  DEFAULT_WALLET_ORIGINS,
  GENLAYER_NETWORKS,
  STATIC_CONTENT_SECURITY_POLICY,
  contentSecurityPolicy,
};
