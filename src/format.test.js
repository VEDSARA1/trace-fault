import { describe, it, expect } from 'vitest';
import { formatEth } from './format.js';

describe('formatEth', () => {
  // The concrete regression: 1234567890000000000 wei is exactly 1.23456789 ETH.
  // The old implementation did Number(BigInt(wei)) / 1e18 first, and rendered
  // "1.234568". Number.MAX_SAFE_INTEGER is only ~0.009 ETH in wei, so routing
  // the value through Number is lossy for essentially any real amount.
  it('formats 1234567890000000000 wei exactly, without Number rounding', () => {
    expect(formatEth('1234567890000000000')).toBe('1.234567');
  });

  it('returns "0" for a zero value', () => {
    expect(formatEth('0')).toBe('0');
    expect(formatEth(0n)).toBe('0');
  });

  it('returns the em dash for unparseable input', () => {
    expect(formatEth('not-a-number')).toBe('—');
    expect(formatEth(undefined)).toBe('—');
  });

  // Values far beyond Number.MAX_SAFE_INTEGER wei, where the old cast diverged.
  it('stays exact well past Number.MAX_SAFE_INTEGER wei', () => {
    // 12345678901234567890 wei = 12.34567890123456789 ETH
    expect(formatEth('12345678901234567890')).toBe('12.345678');
    // 1 ETH exactly
    expect(formatEth('1000000000000000000')).toBe('1');
    // A whole-number amount large enough to need thousand separators
    expect(formatEth('1234000000000000000000')).toBe('1,234');
  });

  it('drops trailing zeros in the fractional part', () => {
    expect(formatEth('1500000000000000000')).toBe('1.5');
    expect(formatEth('2050000000000000000')).toBe('2.05');
  });

  it('truncates rather than rounding at 6 decimals', () => {
    // 0.9999999 ETH must not round up to "1"
    expect(formatEth('999999900000000000')).toBe('0.999999');
  });

  // Below 0.00001 ETH (1e13 wei) the UI keeps exponential notation.
  it('uses exponential notation for very small values', () => {
    expect(formatEth('1234')).toBe('1.23e-15');
    expect(formatEth('1')).toBe('1.00e-18');
    // Carry case: 9.999e-15 rounds to 1.00e-14
    expect(formatEth('9999')).toBe('1.00e-14');
  });

  it('formats the boundary at 0.00001 ETH as a decimal, not exponential', () => {
    expect(formatEth('10000000000000')).toBe('0.00001');
  });

  it('handles negative values with a sign', () => {
    expect(formatEth('-1500000000000000000')).toBe('-1.5');
  });
});
