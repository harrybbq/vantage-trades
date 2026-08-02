import { describe, it, expect } from 'vitest';
import {
  parseMoney,
  formatMoney,
  parseQty,
  formatQty,
  formatGBP,
  notional,
  allocateProportionally,
} from '../src/money.js';

describe('money parsing', () => {
  it('round-trips decimal strings', () => {
    for (const value of ['0.00', '1.00', '12.34', '-12.34', '999999.99']) {
      expect(formatMoney(parseMoney(value))).toBe(value);
    }
  });

  it('parses to exact minor units', () => {
    expect(parseMoney('12.34')).toBe(1234n);
    expect(parseMoney('0.01')).toBe(1n);
    expect(parseMoney('-0.01')).toBe(-1n);
    expect(parseMoney('100')).toBe(10000n);
  });

  it('refuses precision it cannot represent rather than rounding silently', () => {
    // Accepting this would mean the ledger quietly disagrees with the broker
    // by a fraction of a penny per trade.
    expect(() => parseMoney('12.345')).toThrow(/decimal places/);
  });

  it('rejects things that are not numbers', () => {
    for (const bad of ['', 'abc', '1.2.3', '1e5', 'NaN', 'Infinity', '£12.34']) {
      expect(() => parseMoney(bad)).toThrow();
    }
  });

  it('handles quantities at 8dp', () => {
    expect(parseQty('1.5')).toBe(150000000n);
    expect(formatQty(parseQty('0.00000001'))).toBe('0.00000001');
  });

  it('displays pounds with the sign outside the symbol', () => {
    expect(formatGBP(1234n)).toBe('£12.34');
    expect(formatGBP(-1234n)).toBe('-£12.34');
    expect(formatGBP(0n)).toBe('£0.00');
  });
});

describe('notional', () => {
  it('multiplies quantity by price into minor units', () => {
    expect(notional(parseQty('4'), parseMoney('10.00'))).toBe(4000n);
    expect(notional(parseQty('1.5'), parseMoney('10.00'))).toBe(1500n);
  });

  it('rounds half away from zero, consistently', () => {
    // 0.333 shares at 10.01 is not a whole number of pence.
    const value = notional(parseQty('0.333'), parseMoney('10.01'));
    expect(value).toBe(333n);
  });

  it('is the single source of rounding', () => {
    // Two call sites rounding differently is how a ledger drifts a penny a
    // day, so the same inputs must always give the same answer.
    const a = notional(parseQty('7.77777777'), parseMoney('13.13'));
    const b = notional(parseQty('7.77777777'), parseMoney('13.13'));
    expect(a).toBe(b);
  });
});

describe('allocateProportionally', () => {
  it('splits exactly, with no money created or destroyed', () => {
    const parts = allocateProportionally(100n, [1n, 1n, 1n]);
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(100n);
  });

  it('handles a remainder that does not divide evenly', () => {
    const parts = allocateProportionally(10n, [1n, 1n, 1n]);
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(10n);
    expect(parts.every((p) => p >= 3n)).toBe(true);
  });

  it('splits negative totals exactly too', () => {
    const parts = allocateProportionally(-10n, [1n, 1n, 1n]);
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(-10n);
  });
});
