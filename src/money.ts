/**
 * Money and quantity as scaled integers.
 *
 * There is no floating point anywhere in this file, and there must never be
 * any in the money path. `0.1 + 0.2 !== 0.3` in IEEE 754, and a ledger whose
 * entries cannot sum to exactly zero cannot be reconciled — which would defeat
 * the one check that tells us the numbers are real.
 *
 * Money is minor units (pence) at scale 2. Quantity is scale 8, because
 * fractional shares are normal and 8dp is what the schema stores.
 */

export const MONEY_SCALE = 2;
export const QTY_SCALE = 8;

const POW10: readonly bigint[] = Array.from({ length: 19 }, (_, i) => 10n ** BigInt(i));

function pow10(n: number): bigint {
  const v = POW10[n];
  if (v === undefined) throw new RangeError(`scale ${n} out of range`);
  return v;
}

/** Signed minor units, e.g. 1234n is £12.34. */
export type Minor = bigint;
/** Quantity at scale 8, e.g. 150000000n is 1.5 shares. */
export type Qty = bigint;

const DECIMAL_RE = /^(-)?(\d+)(?:\.(\d+))?$/;

/**
 * Parse a decimal string at a fixed scale. Rejects anything it cannot
 * represent exactly rather than rounding silently — a rounded price is a
 * position that will not reconcile, and it is better to fail at the boundary
 * than to discover the drift a quarter later.
 */
export function parseScaled(input: string, scale: number): bigint {
  const raw = input.trim();
  const m = DECIMAL_RE.exec(raw);
  if (!m) throw new TypeError(`not a decimal number: ${JSON.stringify(input)}`);

  const [, sign, whole, frac = ''] = m;
  if (frac.length > scale) {
    throw new RangeError(
      `${raw} has ${frac.length} decimal places, more than scale ${scale} can represent exactly`,
    );
  }

  const padded = frac.padEnd(scale, '0');
  const value = BigInt(whole ?? '0') * pow10(scale) + BigInt(padded === '' ? '0' : padded);
  return sign === '-' ? -value : value;
}

export function formatScaled(value: bigint, scale: number): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const unit = pow10(scale);
  const whole = abs / unit;
  const frac = abs % unit;
  const body = scale === 0 ? `${whole}` : `${whole}.${frac.toString().padStart(scale, '0')}`;
  return negative ? `-${body}` : body;
}

/** `parseMoney('12.34') === 1234n` */
export const parseMoney = (input: string): Minor => parseScaled(input, MONEY_SCALE);
/** `formatMoney(1234n) === '12.34'` */
export const formatMoney = (value: Minor): string => formatScaled(value, MONEY_SCALE);

export const parseQty = (input: string): Qty => parseScaled(input, QTY_SCALE);
export const formatQty = (value: Qty): string => formatScaled(value, QTY_SCALE);

/**
 * For display only: `formatGBP(-1234n) === '-£12.34'`.
 *
 * The ledger is denominated in pounds and stores pence. Never parse this back
 * — `parseMoney` is the only way in, and it deliberately rejects anything it
 * cannot represent exactly.
 */
export function formatGBP(value: Minor): string {
  const body = formatMoney(value < 0n ? -value : value);
  return `${value < 0n ? '-' : ''}£${body}`;
}

/**
 * Value of `qty` units at `price` per unit, in minor units.
 *
 * Rounds half away from zero, and it has to round: 0.333 shares at 10.01 is
 * not a whole number of pence. Every caller must use this one function, so
 * that the same trade always produces the same number — two call sites
 * rounding differently is exactly how a ledger drifts by a penny a day.
 */
export function notional(qty: Qty, pricePerUnit: Minor): Minor {
  const scale = pow10(QTY_SCALE);
  const product = qty * pricePerUnit;
  const negative = product < 0n;
  const abs = negative ? -product : product;
  const rounded = (abs + scale / 2n) / scale;
  return negative ? -rounded : rounded;
}

/**
 * Split `total` across `weights` so the parts sum to exactly `total`.
 *
 * Used wherever a single amount has to be shared out — a combined fee across
 * several lots, for instance. Distributing the remainder largest-first means
 * nothing is silently created or destroyed by rounding.
 */
export function allocateProportionally(total: Minor, weights: readonly bigint[]): Minor[] {
  const sum = weights.reduce((a, b) => a + b, 0n);
  if (sum <= 0n) throw new RangeError('weights must sum to a positive value');

  const parts = weights.map((w) => (total * w) / sum);
  let remainder = total - parts.reduce((a, b) => a + b, 0n);

  const order = weights
    .map((w, i) => ({ i, w }))
    .sort((a, b) => (b.w > a.w ? 1 : b.w < a.w ? -1 : 0));

  const step = remainder >= 0n ? 1n : -1n;
  for (let k = 0; remainder !== 0n; k = (k + 1) % order.length) {
    const slot = order[k];
    if (slot === undefined) break;
    const part = parts[slot.i];
    if (part === undefined) break;
    parts[slot.i] = part + step;
    remainder -= step;
  }

  return parts;
}
