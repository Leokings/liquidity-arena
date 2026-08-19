const GEN_DECIMALS = 18;
const ATTO_PER_GEN = 10n ** BigInt(GEN_DECIMALS);

function optionsObject(options) {
  if (options === undefined) return {};
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('GEN amount options must be an object');
  }
  return options;
}

function fractionDigits(value, name, fallback) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 0 || result > GEN_DECIMALS) {
    throw new RangeError(`${name} must be an integer from 0 to ${GEN_DECIMALS}`);
  }
  return result;
}

/**
 * Converts an unformatted base-10 GEN amount into its exact attoGEN value.
 * Numbers are deliberately rejected so floating-point values cannot lose wei.
 */
export function parseGenToAtto(value, options) {
  const { rejectZero = false } = optionsObject(options);
  if (typeof rejectZero !== 'boolean') {
    throw new TypeError('rejectZero must be a boolean');
  }
  if (typeof value !== 'string') {
    throw new TypeError('GEN amount must be a decimal string');
  }

  const match = /^(?:0|[1-9]\d*)(?:\.(\d+))?$/.exec(value);
  if (!match) {
    throw new RangeError('GEN amount must be an unsigned base-10 decimal string without whitespace');
  }

  const fraction = match[1] ?? '';
  if (fraction.length > GEN_DECIMALS) {
    throw new RangeError(`GEN amount cannot have more than ${GEN_DECIMALS} decimal places`);
  }

  const decimalPoint = value.indexOf('.');
  const whole = decimalPoint === -1 ? value : value.slice(0, decimalPoint);
  const paddedFraction = fraction.padEnd(GEN_DECIMALS, '0');
  const atto = BigInt(whole) * ATTO_PER_GEN + BigInt(paddedFraction || '0');

  if (rejectZero && atto === 0n) {
    throw new RangeError('GEN amount must be greater than zero');
  }
  return atto;
}

/**
 * Formats a non-negative attoGEN bigint without locale separators.
 * By default the result is exact and trailing fractional zeroes are removed.
 * A lower maximumFractionDigits rounds half-up for display only.
 */
export function formatAttoToGen(value, options) {
  if (typeof value !== 'bigint') {
    throw new TypeError('attoGEN amount must be a bigint');
  }
  if (value < 0n) {
    throw new RangeError('attoGEN amount cannot be negative');
  }

  const normalizedOptions = optionsObject(options);
  const maximumFractionDigits = fractionDigits(
    normalizedOptions.maximumFractionDigits,
    'maximumFractionDigits',
    GEN_DECIMALS,
  );
  const minimumFractionDigits = fractionDigits(
    normalizedOptions.minimumFractionDigits,
    'minimumFractionDigits',
    0,
  );
  if (minimumFractionDigits > maximumFractionDigits) {
    throw new RangeError('minimumFractionDigits cannot exceed maximumFractionDigits');
  }

  let displayValue = value;
  if (maximumFractionDigits < GEN_DECIMALS) {
    const discardedUnit = 10n ** BigInt(GEN_DECIMALS - maximumFractionDigits);
    displayValue = ((displayValue + discardedUnit / 2n) / discardedUnit) * discardedUnit;
  }

  const whole = displayValue / ATTO_PER_GEN;
  if (maximumFractionDigits === 0) return whole.toString();

  let fraction = (displayValue % ATTO_PER_GEN)
    .toString()
    .padStart(GEN_DECIMALS, '0')
    .slice(0, maximumFractionDigits);
  while (fraction.length > minimumFractionDigits && fraction.endsWith('0')) {
    fraction = fraction.slice(0, -1);
  }
  if (fraction.length < minimumFractionDigits) {
    fraction = fraction.padEnd(minimumFractionDigits, '0');
  }

  return fraction ? `${whole}.${fraction}` : whole.toString();
}
