const WEI_PER_ETH = 1000000000000000000n; // 1e18
const EXPONENTIAL_BELOW_WEI = 10000000000000n; // 1e13 wei = 0.00001 ETH

/**
 * Exponential form for sub-0.00001 ETH amounts, mirroring Number#toExponential(2)
 * but computed from the wei DIGITS so the value never passes through Number.
 * Only 3-digit mantissa arithmetic touches Number, which is always exact.
 */
function weiToExponential(abs) {
  const frac = abs.toString().padStart(18, "0"); // safe: caller guarantees abs < 1e13
  const firstSig = frac.search(/[1-9]/);
  let exponent = -(firstSig + 1);
  const digits = (frac.slice(firstSig) + "0000").slice(0, 4);
  let mantissa = Number(digits.slice(0, 3)); // 100..999
  if (Number(digits[3]) >= 5) mantissa += 1; // round like toExponential(2)
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
