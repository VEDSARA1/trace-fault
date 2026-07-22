const WEI_PER_ETH = 1000000000000000000n; // 1e18
const EXPONENTIAL_BELOW_WEI = 10000000000000n; // 1e13 wei = 0.00001 ETH

/**
 * Exponential form for sub-0.00001 ETH amounts, matching Number#toExponential(2).
 * Derived from the wei digits rather than a float: a naive
 * `(Number(abs) / 1e18).toExponential(2)` disagrees on exact ties (1005 wei
 * gives 1.00e-15 instead of 1.01e-15), because the division is inexact.
 * The digit string has no leading zeros, so its length gives the exponent.
 */
function weiToExponential(abs) {
  const s = abs.toString();
  let exponent = s.length - 19; // 1 wei -> -18
  let mantissa = Math.round(Number((s + "000").slice(0, 4)) / 10); // 4 sig digits -> 3, half-up
  if (mantissa === 1000) { mantissa = 100; exponent += 1; } // 9.99e-7 -> 1.00e-6
  const m = String(mantissa);
  return `${m[0]}.${m.slice(1)}e${exponent}`;
}

/**
 * Format a wei amount (decimal string) as ETH.
 * All arithmetic stays in BigInt: Number.MAX_SAFE_INTEGER is only ~0.009 ETH in
 * wei, so converting first would lose precision on essentially any real value.
 */
export function formatEth(wei) {
  try {
    const w = BigInt(wei);
    if (w === 0n) return "0";

    const negative = w < 0n;
    const abs = negative ? -w : w;
    const sign = negative ? "-" : "";

    if (abs < EXPONENTIAL_BELOW_WEI) return sign + weiToExponential(abs);

    const whole = abs / WEI_PER_ETH;
    const frac = (abs % WEI_PER_ETH).toString().padStart(18, "0");
    // Truncate to 6 decimals; trailing zeros dropped. BigInt#toLocaleString keeps
    // the thousand separators the previous implementation produced, exactly.
    const fracDisplay = frac.slice(0, 6).replace(/0+$/, "");
    const wholeDisplay = whole.toLocaleString();
    return fracDisplay ? `${sign}${wholeDisplay}.${fracDisplay}` : `${sign}${wholeDisplay}`;
  } catch {
    return "—";
  }
}
