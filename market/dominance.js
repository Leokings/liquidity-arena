// Cross-asset market scoring. All directional inputs are percentages;
// absolute crypto prices are deliberately excluded because their units and
// scales are incomparable.

const EPSILON = 1e-12;

export const DEFAULT_DOMINANCE_WEIGHTS = Object.freeze({
  return: 1,
  momentum: 0,
  volatility: 0,
});

export const MINIMUM_TERRITORY_PCT = 5;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const round = (value, digits = 8) => Number(value.toFixed(digits));

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${label} must be a finite number`);
  return number;
}

function metric(observation, key) {
  const value = observation[key];
  return value == null ? 0 : finiteNumber(value, `${observation.id}.${key}`);
}

function zScores(values, maxZ = 3) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;
  const deviation = Math.sqrt(variance);
  if (deviation <= EPSILON) return values.map(() => 0);
  return values.map((value) => clamp((value - mean) / deviation, -maxZ, maxZ));
}

/**
 * Convert non-negative strengths into percentages using largest remainders.
 * The result is deterministic on ties and totals exactly `total` in integer
 * precision units (10 ** precision), avoiding a drifting 99.99/100.01 circle.
 */
export function allocatePercentages(strengths, { total = 100, precision = 2 } = {}) {
  if (!Array.isArray(strengths) || strengths.length === 0) {
    throw new TypeError('strengths must be a non-empty array');
  }
  if (!Number.isInteger(precision) || precision < 0 || precision > 6) {
    throw new RangeError('precision must be an integer from 0 to 6');
  }
  const resolved = strengths.map((value, index) => {
    const number = finiteNumber(value, `strengths[${index}]`);
    if (number < 0) throw new RangeError('strengths cannot be negative');
    return number;
  });
  const target = Math.round(finiteNumber(total, 'total') * (10 ** precision));
  if (target < 0) throw new RangeError('total cannot be negative');

  let sum = resolved.reduce((acc, value) => acc + value, 0);
  const values = sum <= EPSILON ? resolved.map(() => 1) : resolved;
  if (sum <= EPSILON) sum = values.length;

  const rawUnits = values.map((value) => (value / sum) * target);
  const units = rawUnits.map(Math.floor);
  let remaining = target - units.reduce((acc, value) => acc + value, 0);
  const remainderOrder = rawUnits
    .map((value, index) => ({ index, remainder: value - units[index] }))
    .sort((a, b) => (b.remainder - a.remainder) || (a.index - b.index));

  for (let cursor = 0; remaining > 0; cursor += 1, remaining -= 1) {
    units[remainderOrder[cursor % remainderOrder.length].index] += 1;
  }

  const factor = 10 ** precision;
  return units.map((value) => value / factor);
}

/**
 * Calculate scale-free metrics from an asset's chronological closing prices.
 * Lookbacks count intervals, so a lookback of 4 compares the newest close with
 * the close four observations earlier.
 */
export function calculateMarketMetrics(prices, {
  returnLookback = 12,
  momentumLookback = 4,
  volatilityLookback = 12,
} = {}) {
  if (!Array.isArray(prices) || prices.length === 0) {
    throw new TypeError('prices must be a non-empty array');
  }
  for (const [index, price] of prices.entries()) {
    if (!Number.isFinite(price) || price <= 0) {
      throw new RangeError(`prices[${index}] must be a positive finite number`);
    }
  }
  for (const [name, value] of Object.entries({ returnLookback, momentumLookback, volatilityLookback })) {
    if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  }

  const lastIndex = prices.length - 1;
  const percentageChange = (lookback) => {
    const from = prices[Math.max(0, lastIndex - lookback)];
    return ((prices[lastIndex] / from) - 1) * 100;
  };

  const firstReturnIndex = Math.max(1, prices.length - volatilityLookback);
  const intervalReturns = [];
  for (let index = firstReturnIndex; index < prices.length; index += 1) {
    intervalReturns.push(((prices[index] / prices[index - 1]) - 1) * 100);
  }
  const meanReturn = intervalReturns.length
    ? intervalReturns.reduce((sum, value) => sum + value, 0) / intervalReturns.length
    : 0;
  const volatilityPct = intervalReturns.length
    ? Math.sqrt(intervalReturns.reduce((sum, value) => sum + ((value - meanReturn) ** 2), 0) / intervalReturns.length)
    : 0;

  return Object.freeze({
    returnPct: round(percentageChange(returnLookback)),
    momentumPct: round(percentageChange(momentumLookback)),
    volatilityPct: round(volatilityPct),
  });
}

/**
 * Allocate settlement-aligned circular territory from signed return only.
 *
 * Each observation must have a stable `id`; absent metrics are treated as zero.
 * Returns an array in input order. `rank` conveys strength without moving an
 * asset's sector to a different place around the circle.
 */
export function computeDominance(observations, {
  temperature = 1.15,
  precision = 6,
  maxZ = 3,
  minimumPct = MINIMUM_TERRITORY_PCT,
} = {}) {
  if (!Array.isArray(observations) || observations.length === 0) {
    throw new TypeError('observations must be a non-empty array');
  }
  const ids = new Set();
  observations.forEach((observation, index) => {
    if (!observation || typeof observation.id !== 'string' || observation.id.length === 0) {
      throw new TypeError(`observations[${index}].id must be a non-empty string`);
    }
    if (ids.has(observation.id)) throw new RangeError(`duplicate observation id: ${observation.id}`);
    ids.add(observation.id);
  });
  const heat = finiteNumber(temperature, 'temperature');
  if (heat <= 0) throw new RangeError('temperature must be greater than zero');
  const zLimit = finiteNumber(maxZ, 'maxZ');
  if (zLimit <= 0) throw new RangeError('maxZ must be greater than zero');
  const floorPct = finiteNumber(minimumPct, 'minimumPct');
  if (floorPct < 0 || floorPct * observations.length >= 100) {
    throw new RangeError('minimumPct must leave positive distributable territory');
  }

  const returns = observations.map((observation) => metric(observation, 'returnPct'));
  const momentums = observations.map((observation) => metric(observation, 'momentumPct'));
  const volatilities = observations.map((observation) => metric(observation, 'volatilityPct'));
  if (volatilities.some((value) => value < 0)) throw new RangeError('volatilityPct cannot be negative');

  const returnZ = zScores(returns, zLimit);
  const momentumZ = zScores(momentums, zLimit);
  const volatilityZ = zScores(volatilities, zLimit);
  // Softmax keeps territory movement smooth and strictly return-driven. A
  // fixed visible floor prevents any asset from disappearing without allowing
  // momentum or volatility to influence economic rank or area.
  const maxReturnZ = Math.max(...returnZ);
  const strengths = returnZ.map((value) => Math.exp((value - maxReturnZ) / heat));
  const distributable = 100 - (floorPct * observations.length);
  const variable = allocatePercentages(strengths, { total: distributable, precision });
  const allocated = variable.map((value) => round(floorPct + value, precision));
  const strengthTotal = strengths.reduce((sum, value) => sum + value, 0);
  const highOrder = observations
    .map((_, index) => index)
    .sort((a, b) => (returns[b] - returns[a]) || (a - b));
  const lowOrder = [...highOrder].reverse();
  const competitionRanks = (order) => {
    const result = new Map();
    let previousReturn = null;
    let rank = 0;
    order.forEach((index, position) => {
      if (previousReturn === null || returns[index] !== previousReturn) rank = position + 1;
      result.set(index, rank);
      previousReturn = returns[index];
    });
    return result;
  };
  const ranks = competitionRanks(highOrder);
  const lowRanks = competitionRanks(lowOrder);

  return observations.map((observation, index) => Object.freeze({
    id: observation.id,
    dominancePct: allocated[index],
    rank: ranks.get(index),
    lowRank: lowRanks.get(index),
    compositeScore: round(returnZ[index], 6),
    normalizedStrength: round(strengths[index] / strengthTotal, 8),
    components: Object.freeze({
      return: round(returnZ[index], 6),
      momentum: round(momentumZ[index], 6),
      volatility: round(volatilityZ[index], 6),
    }),
  }));
}
