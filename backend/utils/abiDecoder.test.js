import { describe, it, expect } from 'vitest';
import { AbiCoder } from 'ethers';
import { buildErrorSelectorMap, decodeRevertData } from './abiDecoder.js';

const coder = AbiCoder.defaultAbiCoder();

// Build revert data for a custom error: 4-byte selector + ABI-encoded args.
function customErrorData(fragment, types, values) {
  const map = buildErrorSelectorMap([fragment]);
  const [selector] = [...map.keys()];
  return { data: `0x${selector}${coder.encode(types, values).slice(2)}`, map };
}

const err = (name, types) => ({
  type: 'error',
  name,
  inputs: types.map((t, i) => ({ name: `a${i}`, type: t })),
});

describe('decodeRevertData', () => {
  it('returns null for empty revert data', () => {
    expect(decodeRevertData(null)).toBeNull();
    expect(decodeRevertData('0x')).toBeNull();
  });

  it('decodes Error(string)', () => {
    const data = `0x08c379a0${coder.encode(['string'], ['insufficient allowance']).slice(2)}`;
    const out = decodeRevertData(data);
    expect(out.text).toBe('insufficient allowance');
    expect(out.isCustomDecoded).toBe(false);
  });

  it('decodes Panic(uint256) to its named meaning', () => {
    const data = `0x4e487b71${coder.encode(['uint256'], [17n]).slice(2)}`;
    expect(decodeRevertData(data).text).toBe('Panic: Arithmetic overflow/underflow');
  });

  it('falls back to the raw selector for an error not in the ABI', () => {
    const out = decodeRevertData(`0x1234abcd${'0'.repeat(64)}`, new Map());
    expect(out.text).toBe('Custom error: 0x1234abcd');
    expect(out.isCustomDecoded).toBe(false);
  });

  it('decodes a custom error with named args', () => {
    const fragment = { type: 'error', name: 'ReturnAmountIsNotEnough', inputs: [
      { name: 'result', type: 'uint256' }, { name: 'minReturn', type: 'uint256' },
    ] };
    const { data, map } = customErrorData(fragment, ['uint256', 'uint256'], [102472120n, 102522223n]);
    const out = decodeRevertData(data, map);
    expect(out.isCustomDecoded).toBe(true);
    expect(out.errorName).toBe('ReturnAmountIsNotEnough');
    expect(out.text).toBe('ReturnAmountIsNotEnough(result: 102472120, minReturn: 102522223)');
  });

  // --- Regressions: the hand-rolled frontend decoder got these wrong. ---

  // int<N> is sign-extended across the full 32-byte word. The old decoder
  // subtracted 2^bits using the DECLARED width, so int128 -7 came out as
  // 115792089237316195423570985008687907852929702298719625575994209400481361428473.
  it('decodes a negative int128 (was catastrophically wrong)', () => {
    const fragment = err('E', ['int128']);
    const { data, map } = customErrorData(fragment, ['int128'], [-7n]);
    expect(decodeRevertData(data, map).args[0].value).toBe('-7');
  });

  it('decodes a negative int256', () => {
    const fragment = err('E', ['int256']);
    const { data, map } = customErrorData(fragment, ['int256'], [-500n]);
    expect(decodeRevertData(data, map).args[0].value).toBe('-500');
  });

  // Arrays were unsupported: the old decoder read the head OFFSET word as the
  // value, so [1,2,3] silently rendered as "32" (0x20).
  it('decodes a uint256[] (was silently rendering the offset)', () => {
    const fragment = err('E', ['uint256[]']);
    const { data, map } = customErrorData(fragment, ['uint256[]'], [[1n, 2n, 3n]]);
    expect(decodeRevertData(data, map).args[0].value).toBe('[1, 2, 3]');
  });

  it('decodes an address[]', () => {
    const addr = '0x1111111111111111111111111111111111111111';
    const fragment = err('E', ['address[]']);
    const { data, map } = customErrorData(fragment, ['address[]'], [[addr]]);
    expect(decodeRevertData(data, map).args[0].value).toBe(`[${addr}]`);
  });

  it('decodes mixed static and dynamic args', () => {
    const fragment = err('E', ['uint256', 'string']);
    const { data, map } = customErrorData(fragment, ['uint256', 'string'], [42n, 'too low']);
    const values = decodeRevertData(data, map).args.map(a => a.value);
    expect(values).toEqual(['42', 'too low']);
  });
});
