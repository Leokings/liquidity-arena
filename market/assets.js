// Canonical instruments for the circular market arena.
//
// Prices in this file are synthetic demo anchors, not live quotes. Market
// dominance is always calculated from percentage changes, so instruments with
// different units and price scales remain comparable.

const freezeAsset = (asset) => Object.freeze({
  ...asset,
  visual: Object.freeze({ ...asset.visual }),
  demo: Object.freeze({ ...asset.demo }),
});

export const MARKET_ASSETS = Object.freeze([
  freezeAsset({
    id: 'btc',
    symbol: 'BTC/USDT',
    ticker: 'BTCUSDT',
    contractId: 'BTC',
    name: 'Bitcoin',
    shortName: 'Bitcoin',
    assetClass: 'crypto',
    base: 'BTC',
    quote: 'USDT',
    unit: 'USDT per BTC',
    priceDecimals: 2,
    visual: {
      primary: '#f7931a',
      secondary: '#ffd08a',
      shadow: '#6f3700',
      material: 'bitcoin-gold',
      viscosity: 0.68,
    },
    demo: { startPrice: 100000, volatility: 0.0024, macroBeta: 1, phase: 0.3 },
  }),
  freezeAsset({
    id: 'eth',
    symbol: 'ETH/USDT',
    ticker: 'ETHUSDT',
    contractId: 'ETH',
    name: 'Ethereum',
    shortName: 'Ethereum',
    assetClass: 'crypto',
    base: 'ETH',
    quote: 'USDT',
    unit: 'USDT per ETH',
    priceDecimals: 2,
    visual: {
      primary: '#627eea',
      secondary: '#b5c2ff',
      shadow: '#202f78',
      material: 'ether-blue',
      viscosity: 0.54,
    },
    demo: { startPrice: 3500, volatility: 0.003, macroBeta: 1.12, phase: 1.1 },
  }),
  freezeAsset({
    id: 'bnb',
    symbol: 'BNB/USDT',
    ticker: 'BNBUSDT',
    contractId: 'BNB',
    name: 'BNB',
    shortName: 'BNB',
    assetClass: 'crypto',
    base: 'BNB',
    quote: 'USDT',
    unit: 'USDT per BNB',
    priceDecimals: 2,
    visual: {
      primary: '#f3ba2f',
      secondary: '#ffe49a',
      shadow: '#755309',
      material: 'bnb-amber',
      viscosity: 0.62,
    },
    demo: { startPrice: 700, volatility: 0.0028, macroBeta: 1.05, phase: 2.2 },
  }),
  freezeAsset({
    id: 'sol',
    symbol: 'SOL/USDT',
    ticker: 'SOLUSDT',
    contractId: 'SOL',
    name: 'Solana',
    shortName: 'Solana',
    assetClass: 'crypto',
    base: 'SOL',
    quote: 'USDT',
    unit: 'USDT per SOL',
    priceDecimals: 2,
    visual: {
      primary: '#14f195',
      secondary: '#9945ff',
      shadow: '#083f35',
      material: 'solana-neon',
      viscosity: 0.43,
    },
    demo: { startPrice: 180, volatility: 0.0041, macroBeta: 1.25, phase: 3.4 },
  }),
  freezeAsset({
    id: 'xrp',
    symbol: 'XRP/USDT',
    ticker: 'XRPUSDT',
    contractId: 'XRP',
    name: 'XRP',
    shortName: 'XRP',
    assetClass: 'crypto',
    base: 'XRP',
    quote: 'USDT',
    unit: 'USDT per XRP',
    priceDecimals: 4,
    visual: {
      primary: '#23a9e0',
      secondary: '#b7edff',
      shadow: '#0b4960',
      material: 'xrp-cyan',
      viscosity: 0.48,
    },
    demo: { startPrice: 2.5, volatility: 0.0036, macroBeta: 1.15, phase: 4.2 },
  }),
]);

export const MARKET_ASSET_IDS = Object.freeze(MARKET_ASSETS.map((asset) => asset.id));

const ASSET_BY_ID = new Map(MARKET_ASSETS.map((asset) => [asset.id, asset]));

/** Return canonical metadata for an asset id, or undefined when it is unknown. */
export function getMarketAsset(id) {
  return ASSET_BY_ID.get(id);
}

/**
 * Resolve a custom asset list to canonical metadata and reject duplicate ids.
 * Keeping one stable order prevents sectors from jumping around the circle.
 */
export function resolveMarketAssets(assets = MARKET_ASSETS) {
  if (!Array.isArray(assets) || assets.length === 0) {
    throw new TypeError('assets must be a non-empty array');
  }

  const resolved = assets.map((asset) => {
    if (typeof asset === 'string') {
      const canonical = getMarketAsset(asset);
      if (!canonical) throw new RangeError(`Unknown market asset: ${asset}`);
      return canonical;
    }
    if (!asset || typeof asset.id !== 'string' || asset.id.length === 0) {
      throw new TypeError('each asset must be an id string or metadata object with an id');
    }
    return asset;
  });

  const ids = new Set();
  for (const asset of resolved) {
    if (ids.has(asset.id)) throw new RangeError(`Duplicate market asset: ${asset.id}`);
    ids.add(asset.id);
  }
  return resolved;
}
