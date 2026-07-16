/**
 * utils/abiDecoder.js
 *
 * Utilities for ABI-based custom error decoding.
 * Uses ethers v6 for selector computation and ABI decoding.
 *
 * Public API:
 *   buildErrorSelectorMap(abi)          → Map<selector8hex, fragment>
 *   decodeCustomErrorArgs(fragment, argHex) → [{ name, type, value }, ...]
 */

import { id as keccakId, AbiCoder, Fragment } from 'ethers';

/**
 * Compute the 4-byte selector (8 hex chars, no 0x) for an error ABI fragment.
 * Example: "InsufficientLiquidity(uint256,uint256)" → "0a3b573b"
 */
function errorSelector(fragment) {
  // Fragment.from validates + normalizes the ABI entry before hashing
  const frag = Fragment.from(fragment);
  const sig = frag.format('sighash'); // e.g. "InsufficientLiquidity(uint256,uint256)"
  const fullHash = keccakId(sig);     // "0x" + 64 hex chars
  return fullHash.slice(2, 10);       // first 4 bytes without 0x
}

/**
 * Build a Map<selectorHex, abiFragment> from a parsed ABI array.
 * Only entries with type === "error" are processed.
 * Keys are lowercase 8-char hex WITHOUT 0x prefix.
 *
 * @param {Array} abi  - Parsed ABI (array of JSON objects)
 * @returns {Map<string, object>}
 */
export function buildErrorSelectorMap(abi) {
  const map = new Map();
  if (!Array.isArray(abi)) return map;

  for (const entry of abi) {
    if (entry.type !== 'error') continue;
    try {
      const selector = errorSelector(entry);
      map.set(selector.toLowerCase(), entry);
    } catch {
      // Skip malformed or unsupported ABI entries
    }
  }
  return map;
}

/**
 * Decode the argument bytes that follow the 4-byte selector in custom error data.
 * Returns an array of decoded parameter objects.
 *
 * @param {object} fragment  - ABI error fragment (JSON object from the ABI array)
 * @param {string} argHex    - Hex string (no 0x) of bytes AFTER the 4-byte selector
 * @returns {Array<{ name: string, type: string, value: string }>}
 */
export function decodeCustomErrorArgs(fragment, argHex) {
  const inputs = fragment.inputs || [];
  if (inputs.length === 0) return [];
  if (!argHex || argHex.length === 0) return inputs.map((inp, i) => ({
    name: inp.name || `arg${i}`,
    type: inp.type,
    value: '',
  }));

  try {
    const coder = AbiCoder.defaultAbiCoder();
    const types = inputs.map(inp => inp.type);
    const decoded = coder.decode(types, `0x${argHex}`);

    return inputs.map((inp, i) => ({
      name: inp.name || `arg${i}`,
      type: inp.type,
      value: formatDecodedValue(decoded[i], inp.type),
    }));
  } catch {
    // Decoding failed (e.g. truncated data) – return raw slots
    return inputs.map((inp, i) => ({
      name: inp.name || `arg${i}`,
      type: inp.type,
      value: `0x${argHex.slice(i * 64, i * 64 + 64)}`,
    }));
  }
}

/**
 * Format a decoded ethers value into a human-readable string.
 * BigInt values are stringified; addresses lowercased; bytes kept as hex.
 */
function formatDecodedValue(value, type) {
  try {
    if (value === null || value === undefined) return '';
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'boolean') return String(value);
    if (typeof value === 'string') return value;
    if (type === 'address') return String(value).toLowerCase();
    if (Array.isArray(value)) return `[${value.map((v) => formatDecodedValue(v, '')).join(', ')}]`;
    // Bytes types come back as Uint8Array / hex string from ethers
    return String(value);
  } catch {
    return String(value);
  }
}
