import { useState, useRef, useEffect } from "react";
import { formatEth } from "./format.js";

// Backend URL — set VITE_API_URL in your deployment environment.
// Falls back to localhost for local development.
const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:5000";

const PROTOCOL_REGISTRY = {
  "0x1111111254eeb25477b68fb85ed929f73a960582": "1inch Aggregation Router V5",
  "0x1111111254fb6c44bac0bed2854e76f90643097d": "1inch Aggregation Router V4",
  "0x111111125421ca6dc452d289314280a0f8842a65": "1inch Aggregation Router V6",
  "0xe592427a0aece92de3edee1f18e0157c05861564": "Uniswap V3 Router",
  "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45": "Uniswap V3 Router 2",
  "0x7a250d5630b4cf539739df2c5dacb4c659f2488d": "Uniswap V2 Router",
  "0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad": "Uniswap Universal Router",
  "0x00000000006c3852cbef3e08e8df289169ede581": "Seaport 1.1",
  "0x00000000000006c7676171937c444f6bde3d6282": "Seaport 1.2",
  "0x0000000000000068f116a894984e2db1123eb395": "Seaport 1.6",
  "0x00000000000000adc04c56bf30ac9d3c0aaf14dc": "Seaport 1.5",
  "0x7f268357a8c2552623316e2562d90e642bb538e5": "OpenSea Wyvern V2",
  "0x7d2768de32b0b80b7a3454c06bdac94a69ddc7a9": "Aave V2 Lending Pool",
  "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2": "Aave V3 Pool",
  "0x3d9819210a31b4961b30ef54be2aed79b9c9cd3b": "Compound V2 Comptroller",
  "0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f": "SushiSwap Router",
  "0xd51a44d3fae010294c616388b506acda1bfaae46": "Curve TriCrypto",
  "0xae7ab96520de3a18e5e111b5eaab095312d7fe84": "Lido stETH",
  "0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789": "ERC-4337 EntryPoint V0.6",
  "0x0000000071727de22e5e9d8baf0edac6f37da032": "ERC-4337 EntryPoint V0.7",
};

// Gas ratio at/above which an out-of-gas failure is near-certain. Shared as the
// single source of truth between the pre-trace gate (skip the eth_call replay)
// and the "Likely OOG" label, so the two can never disagree. The 0.95 "Possible
// OOG" branch below is a separate, looser heuristic and intentionally NOT tied
// to this constant.
const OOG_CERTAIN_RATIO = 0.999;

// A transaction's analysis outcome. DECODED: we recovered a revert reason.
// SILENT: the replay reverted with nothing to decode (or the OOG gate skipped it
// on strong gas evidence). UNDETERMINED: we never established anything — the
// trace failed or the replay didn't reproduce the failure.
const STATUS = { DECODED: "decoded", SILENT: "silent", UNDETERMINED: "undetermined" };

function classifySilentFailure(gasUsed, gasLimit) {
  if (!gasLimit) return "Bare revert() or custom error (no message)";
  const ratio = gasUsed / gasLimit;
  if (ratio >= OOG_CERTAIN_RATIO) return "Likely OOG (Out of Gas)";
  if (ratio >= 0.95) return "Possible OOG";
  return "Bare revert() or custom error (no message)";
}

function lookupProtocol(address) {
  if (!address) return null;
  return PROTOCOL_REGISTRY[address.toLowerCase()] || null;
}

function txTypeLabel(type) {
  if (type === 0) return "legacy (0)";
  if (type === 1) return "EIP-2930 (1)";
  if (type === 2) return "EIP-1559 (2)";
  return type == null ? "—" : `type ${type}`;
}

export default function App() {
  const [contractAddress, setContractAddress] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState("");
  const [error, setError] = useState("");
  const [results, setResults] = useState([]);
  const [totalFailed, setTotalFailed] = useState(0);
  const [addressType, setAddressType] = useState(null); // 'wallet' | 'contract'
  const [analyzed, setAnalyzed] = useState(false);
  const [traceActive, setTraceActive] = useState(false);
  const traceRef = useRef(null);
  const abortRef = useRef(null);

  useEffect(() => {
    if (traceActive && traceRef.current) {
      traceRef.current.style.transition = "none";
      traceRef.current.style.width = "0%";
      setTimeout(() => {
        if (traceRef.current) {
          traceRef.current.style.transition = "";
          traceRef.current.style.width = "100%";
        }
      }, 50);
    }
  }, [traceActive]);

  async function fetchAndAnalyze() {
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;

    setError(""); setResults([]); setTotalFailed(0); setAnalyzed(false);
    setAddressType(null);
    if (!contractAddress.trim() || !contractAddress.startsWith("0x") || contractAddress.length !== 42)
      return setError("Enter a valid address (0x + 40 hex characters).");

    setLoading(true); setTraceActive(true);
    setLoadingMsg("Fetching failed transactions from backend...");

    try {
      // Address type and transactions are independent — fetch concurrently.
      // No ABI prefetch: /api/trace resolves the ABI (cached server-side) and
      // returns the already-decoded revert reason plus the verified flag.
      const [res, typeRes] = await Promise.all([
        fetch(`${API_BASE}/api/transactions/${contractAddress}`, { signal }),
        fetch(`${API_BASE}/api/address-type/${contractAddress}`, { signal }),
      ]);

      if (!res.ok) {
        if (res.status === 429)
          return setError("Etherscan rate-limited the backend. Please wait a moment and try again.");
        if (res.status === 500)
          return setError("Something went wrong on our end. Please try again shortly.");
        return setError("The backend couldn't reach Etherscan. Please try again shortly.");
      }

      // Type is best-effort: if it fails we fall back to 'contract', which keeps
      // every transaction rather than wrongly filtering any out.
      const type = typeRes.ok ? (await typeRes.json()).type : "contract";
      const isWallet = type === "wallet";
      setAddressType(type);

      const json = await res.json();

      if (json.status === "0") {
        if (json.message === "No transactions found")
          return setError("No transactions found for this address.");
        throw new Error(json.result || json.message);
      }

      let allFailed = (json.result || []).filter(tx => tx.isError === "1");
      if (allFailed.length === 0)
        return setError("No failed transactions found in the last 500 transactions.");

      // Etherscan's txlist returns both directions. For a WALLET the meaningful
      // failures are the ones it sent — inbound transfers that failed belong to
      // someone else, and replaying a call to an EOA yields nothing anyway, so
      // they'd only pad the results with unexplainable "silent" rows. For a
      // CONTRACT the inbound calls are exactly what we want, so keep them all.
      if (isWallet) {
        const outbound = allFailed.filter(tx => tx.from?.toLowerCase() === contractAddress.toLowerCase());
        if (outbound.length < allFailed.length)
          console.info(`Skipped ${allFailed.length - outbound.length} inbound failure(s) — not sent by this wallet`);
        allFailed = outbound;
        if (allFailed.length === 0)
          return setError("No failed transactions sent by this wallet in the last 500 transactions.");
      }

      // Contract creations come back with an empty `to` (and a populated
      // contractAddress). They have no callee to replay via eth_call, and
      // semantically they're deployments BY this address, not failed calls TO
      // it — so they're excluded from analysis entirely.
      const failedTxs = allFailed.filter(tx => tx.to);
      if (failedTxs.length === 0)
        return setError("Only contract-creation failures found — nothing to trace.");
      if (failedTxs.length < allFailed.length)
        console.info(`Skipped ${allFailed.length - failedTxs.length} contract-creation tx(s) — not traceable`);

      // totalFailed deliberately counts analyzable failed CALLS (creations
      // excluded) so the summary matches what the analysis can actually show.
      setTotalFailed(failedTxs.length);

      const enriched = [];
      for (let i = 0; i < Math.min(failedTxs.length, 20); i++) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const tx = failedTxs[i];
        setLoadingMsg(`Decoding transaction ${i + 1} of ${Math.min(failedTxs.length, 20)}...`);

        const gasUsed = parseInt(tx.gasUsed);
        const gasLimit = parseInt(tx.gas);

        let revertReason = null;
        let contractVerified = false;
        // Set when we could NOT establish what happened. Distinct from a genuine
        // bare revert: claiming "reverted with no message" for a tx we never
        // successfully replayed asserts a fact about the chain we never learned.
        let undetermined = null;
        // Cost gate: when gas usage alone makes an out-of-gas failure near-certain
        // (>= OOG_CERTAIN_RATIO), skip the /api/trace eth_call replay — it costs an
        // RPC round trip we already know won't yield a useful revert reason, and an
        // eth_call replay of an OOG tx is unreliable anyway (it runs against the
        // node's gas cap, not the tx's original limit). Heuristic tradeoff: a tx
        // could deliberately revert this close to its limit and carry a real reason;
        // gating here means that reason isn't fetched. Intentional for the common case.
        const skipTrace = gasLimit > 0 && gasUsed / gasLimit >= OOG_CERTAIN_RATIO;
        if (!skipTrace) {
          try {
            const traceRes = await fetch(`${API_BASE}/api/trace`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                to: tx.to,
                data: tx.input,
                blockNumber: tx.blockNumber,
                // Replay fidelity: forward sender + gas so msg.sender-gated
                // reverts reproduce correctly (backend treats both as optional).
                from: tx.from,
                gas: tx.gas
              }),
              signal,
            });
            // Our backend surfaces failures as distinct HTTP statuses. One bad trace
            // shouldn't kill the whole analysis — record it as undetermined and move on.
            if (!traceRes.ok) {
              undetermined = traceRes.status === 429
                ? "Rate-limited — not analyzed"
                : `Trace unavailable (HTTP ${traceRes.status})`;
              console.warn(`Trace failed (status ${traceRes.status}) on tx ${tx.hash}; marking undetermined.`);
            } else {
              // The backend decodes server-side and returns the reason ready to render.
              const traceJson = await traceRes.json();
              contractVerified = traceJson.verified || false;
              if (traceJson.outcome === "succeeded") {
                // The replay ran without reverting, so it did not reproduce the
                // on-chain failure — state at the replayed block differs from
                // the state the transaction actually executed against.
                undetermined = "Replay succeeded — failure not reproduced";
              } else {
                // Reverted. A null revert here is a genuine bare revert.
                revertReason = traceJson.revert || null;
              }
            }
          } catch (e) {
            if (e.name === 'AbortError') throw e;
            undetermined = "Trace request error";
            console.warn(`Trace error for tx ${tx.hash}:`, e.message);
          }
        }

        // One explicit outcome per transaction, decided once here. Everything
        // downstream (bucketing, the summary counts, the pill) keys off it
        // rather than re-deriving the same rule from two nullable fields.
        const status = revertReason ? STATUS.DECODED : undetermined ? STATUS.UNDETERMINED : STATUS.SILENT;

        enriched.push({
          hash: tx.hash,
          blockNumber: tx.blockNumber,
          from: tx.from,
          to: tx.to,
          protocol: lookupProtocol(tx.to),
          input: tx.input,
          gasUsed,
          gasLimit,
          gasPercent: gasLimit > 0 ? Math.round((gasUsed / gasLimit) * 100) : 0,
          status,
          revertReason: revertReason?.text || null,
          revertDecoded: revertReason?.isCustomDecoded ? revertReason : null,
          undetermined,
          // Only claim a silent failure when we actually observed one: either the
          // replay reverted without data, or the OOG gate skipped it on strong
          // gas evidence. Never for a trace we failed to complete.
          silentType: status === STATUS.SILENT ? classifySilentFailure(gasUsed, gasLimit) : null,
          timeStamp: tx.timeStamp,
          contractVerified,
        });
      }

      setResults(enriched);
      setAnalyzed(true);
    } catch (err) {
      if (err.name === 'AbortError') return;
      setError(`Error: ${err.message}`);
    } finally {
      if (abortRef.current === controller) {
        setLoading(false); setTraceActive(false);
        abortRef.current = null;
      }
    }
  }

  const countByStatus = status => results.reduce((n, tx) => n + (tx.status === status ? 1 : 0), 0);
  const shortHash = h => `${h.slice(0, 8)}...${h.slice(-6)}`;
  const formatTime = ts => new Date(parseInt(ts) * 1000).toLocaleString();

  return (
    <div style={{ minHeight: "100vh", background: "#0A0E1A", color: "#CBD5E1", fontFamily: "'Inter', sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 6px; } ::-webkit-scrollbar-track { background: #0A0E1A; } ::-webkit-scrollbar-thumb { background: #2D3748; border-radius: 3px; }
        .tx-card:hover { border-color: #4FFFB0 !important; transition: border-color 0.2s; }
        .btn-primary:hover { background: #3DEBA0 !important; }
        .btn-settings:hover { background: #1C2333 !important; }
        .trace-bar { height: 2px; background: linear-gradient(90deg, #4FFFB0, #00B4D8); transition: width 1.8s cubic-bezier(0.4,0,0.2,1); border-radius: 1px; }
        .pill { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 11px; font-family: 'JetBrains Mono', monospace; font-weight: 500; }
        .pill-protocol { background: #0D2137; color: #4FFFB0; border: 1px solid #1A4A6A; }
        .pill-silent { background: #2D1515; color: #FF6B6B; border: 1px solid #5C2020; }
        .pill-oog { background: #2D2415; color: #FFB347; border: 1px solid #5C4020; }
        .pill-revert { background: #1A1A2E; color: #A78BFA; border: 1px solid #3D3060; }
        .pill-custom { background: #0D2320; color: #4FFFB0; border: 1px solid #1A5040; }
        .pill-unverified { background: #1C1C1C; color: #64748B; border: 1px solid #2D3748; }
        .pill-undetermined { background: #171B24; color: #8892A4; border: 1px solid #2D3748; }
        input::placeholder { color: #4A5568; }
        input:focus { outline: none; border-color: #4FFFB0 !important; }
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>

      {/* Top bar */}
      <div style={{ background: "#0D1220", borderBottom: "1px solid #1C2333", padding: "0 24px", display: "flex", alignItems: "center", justifyContent: "space-between", height: "56px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <div style={{ width: 28, height: 28, borderRadius: "6px", background: "linear-gradient(135deg, #4FFFB0 0%, #00B4D8 100%)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "14px", fontWeight: 700, color: "#0A0E1A" }}>⬡</div>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 500, fontSize: "15px", color: "#E2E8F0", letterSpacing: "-0.3px" }}>
            trace<span style={{ color: "#4FFFB0" }}>fault</span>
          </span>
          <span style={{ fontSize: "11px", color: "#4A5568", marginLeft: "4px", fontFamily: "'JetBrains Mono', monospace" }}>v1.0</span>
        </div>
      </div>

      {/* Trace bar */}
      <div style={{ height: "2px", background: "#0D1220", overflow: "hidden" }}>
        <div ref={traceRef} className="trace-bar" style={{ width: "0%" }} />
      </div>

      {/* Main */}
      <div style={{ maxWidth: "1100px", margin: "0 auto", padding: "32px 24px" }}>
        <div style={{ marginBottom: "28px" }}>
          <h1 style={{ fontSize: "26px", fontWeight: 600, color: "#F1F5F9", fontFamily: "'JetBrains Mono', monospace", letterSpacing: "-0.5px", marginBottom: "8px" }}>
            Failed Transaction Analyzer
          </h1>
          <p style={{ fontSize: "14px", color: "#64748B", maxWidth: "560px", lineHeight: "1.6" }}>
            Enter a wallet or contract address to fetch its failed transactions, decode revert reasons, and classify silent failures.
          </p>
        </div>

        {/* Input */}
        <div style={{ display: "flex", gap: "12px", marginBottom: "12px", flexWrap: "wrap" }}>
          <input
            value={contractAddress}
            onChange={e => setContractAddress(e.target.value)}
            onKeyDown={e => e.key === "Enter" && fetchAndAnalyze()}
            placeholder="0x wallet or contract address"
            style={{ flex: 1, minWidth: "280px", background: "#0D1220", border: "1px solid #2D3748", color: "#E2E8F0", padding: "11px 16px", borderRadius: "8px", fontSize: "14px", fontFamily: "'JetBrains Mono', monospace" }}
          />
          <button className="btn-primary" onClick={fetchAndAnalyze} disabled={loading} style={{ background: loading ? "#2D3748" : "#4FFFB0", color: loading ? "#8892A4" : "#0A0E1A", border: "none", padding: "11px 24px", borderRadius: "8px", cursor: loading ? "not-allowed" : "pointer", fontSize: "14px", fontWeight: 600, whiteSpace: "nowrap", transition: "background 0.2s" }}>
            {loading ? "Analyzing..." : "Analyze →"}
          </button>
        </div>

        {/* Quick fill */}
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "24px" }}>
          {[
            ["1inch V6", "0x111111125421ca6dc452d289314280a0f8842a65"],
            ["Seaport 1.6", "0x0000000000000068F116a894984e2DB1123eB395"],
            ["Uniswap V3", "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45"],
            ["Aave V3", "0x87870Bca3F3fD6335C3F4CE8392D69350B4fA4E2"],
            ["vitalik.eth (wallet)", "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"],
          ].map(([label, addr]) => (
            <button key={addr} onClick={() => setContractAddress(addr)} style={{ background: "transparent", border: "1px solid #2D3748", color: "#8892A4", padding: "4px 12px", borderRadius: "999px", cursor: "pointer", fontSize: "12px", fontFamily: "'JetBrains Mono', monospace" }}>
              {label}
            </button>
          ))}
        </div>

        {/* Loading */}
        {loading && (
          <div style={{ background: "#0D1220", border: "1px solid #1C2333", borderRadius: "10px", padding: "24px", display: "flex", alignItems: "center", gap: "16px" }}>
            <div style={{ width: "20px", height: "20px", border: "2px solid #1C2333", borderTop: "2px solid #4FFFB0", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
            <span style={{ fontSize: "14px", color: "#8892A4", fontFamily: "'JetBrains Mono', monospace" }}>{loadingMsg}</span>
          </div>
        )}

        {/* Error */}
        {error && (
          <div style={{ background: "#1A0A0A", border: "1px solid #5C2020", borderRadius: "8px", padding: "14px 18px", color: "#FF6B6B", fontSize: "13px", fontFamily: "'JetBrains Mono', monospace" }}>
            ✕ {error}
          </div>
        )}

        {/* Results */}
        {analyzed && !loading && (
          <div>
            {/* What was analyzed — the two address types mean different things. */}
            {addressType && (
              <div style={{ fontSize: "12px", color: "#4A5568", marginBottom: "12px", fontFamily: "'JetBrains Mono', monospace" }}>
                <span className="pill pill-protocol" style={{ marginRight: "8px" }}>
                  {addressType === "wallet" ? "WALLET" : "CONTRACT"}
                </span>
                {addressType === "wallet"
                  ? "failed transactions sent by this wallet"
                  : "failed calls made to this contract"}
              </div>
            )}

            {/* Summary */}
            <div style={{ display: "flex", gap: "16px", marginBottom: "28px", flexWrap: "wrap" }}>
              {[
                { label: `${addressType === "wallet" ? "Failed Sent" : "Total Failed"}${totalFailed > results.length ? ` (${results.length} analyzed)` : ""}`, value: totalFailed, color: "#E2E8F0" },
                { label: "Decoded Failures", value: countByStatus(STATUS.DECODED), color: "#4FFFB0" },
                { label: "Silent Failures", value: countByStatus(STATUS.SILENT), color: "#FF6B6B" },
                { label: "Undetermined", value: countByStatus(STATUS.UNDETERMINED), color: "#8892A4" },
              ].map(({ label, value, color }) => (
                <div key={label} style={{ background: "#0D1220", border: "1px solid #1C2333", borderRadius: "8px", padding: "14px 20px", minWidth: "140px" }}>
                  <div style={{ fontSize: "24px", fontWeight: 600, color, fontFamily: "'JetBrains Mono', monospace" }}>{value}</div>
                  <div style={{ fontSize: "12px", color: "#4A5568", marginTop: "2px" }}>{label}</div>
                </div>
              ))}
            </div>

            {/* Three buckets: decoded, genuinely silent, and not established. */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "24px" }}>
              {[
                { type: STATUS.DECODED, label: "DECODED FAILURES", dot: "#4FFFB0", border: "#1A2E3A" },
                { type: STATUS.SILENT, label: "SILENT FAILURES", dot: "#FF6B6B", border: "#2D1515" },
                { type: STATUS.UNDETERMINED, label: "UNDETERMINED", dot: "#8892A4", border: "#242C3A" },
              ].map(({ type, label, dot, border }) => {
                const bucket = results.filter(tx => tx.status === type);
                return (
                <div key={type}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "16px" }}>
                    <div style={{ width: "8px", height: "8px", borderRadius: "50%", background: dot }} />
                    <span style={{ fontSize: "13px", fontWeight: 600, color: dot, fontFamily: "'JetBrains Mono', monospace", letterSpacing: "0.05em" }}>{label}</span>
                    <span style={{ fontSize: "12px", color: "#4A5568" }}>({bucket.length})</span>
                  </div>
                  {bucket.length === 0
                    ? <div style={{ color: "#4A5568", fontSize: "13px", padding: "20px 0" }}>
                        {type === STATUS.UNDETERMINED ? "Every transaction was accounted for." : `No ${type} failures found.`}
                      </div>
                    : <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                        {bucket.map(tx => <TxCard key={tx.hash} tx={tx} border={border} shortHash={shortHash} formatTime={formatTime} />)}
                      </div>
                  }
                </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Empty state */}
        {!analyzed && !loading && !error && (
          <div style={{ textAlign: "center", padding: "60px 20px", border: "1px dashed #1C2333", borderRadius: "12px" }}>
            <div style={{ fontSize: "32px", marginBottom: "12px", opacity: 0.4 }}>⬡</div>
            <p style={{ color: "#4A5568", fontSize: "14px" }}>Enter a wallet or contract address to begin.</p>
            <p style={{ color: "#2D3748", fontSize: "12px", marginTop: "6px", fontFamily: "'JetBrains Mono', monospace" }}>Scans 500 transactions, analyzes up to 20 failed ones</p>
          </div>
        )}
      </div>
    </div>
  );
}

function TxCard({ tx, border, shortHash, formatTime }) {
  const [expanded, setExpanded] = useState(false);
  const [enrich, setEnrich] = useState(null);
  const [enrichLoading, setEnrichLoading] = useState(false);
  const [enrichError, setEnrichError] = useState("");
  const enrichFetchedRef = useRef(false);
  const isOOG = tx.silentType?.includes("OOG");
  const isCustomDecoded = !!tx.revertDecoded;

  // Lazy enrichment: fetch receipt + tx-by-hash only the first time this card
  // is expanded, so we don't spend Etherscan calls on cards nobody opens.
  // A ref guards against re-fetching; the effect depends only on expand/hash so
  // toggling loading state can't re-trigger and cancel the in-flight request.
  useEffect(() => {
    if (!expanded || enrichFetchedRef.current) return;
    enrichFetchedRef.current = true;
    (async () => {
      setEnrichLoading(true); setEnrichError("");
      try {
        const res = await fetch(`${API_BASE}/api/enrich/${tx.hash}`);
        if (!res.ok) {
          setEnrichError(res.status === 429 ? "Rate-limited — try again shortly." : "Couldn't load transaction details.");
          return;
        }
        setEnrich(await res.json());
      } catch {
        setEnrichError("Couldn't load transaction details.");
      } finally {
        setEnrichLoading(false);
      }
    })();
  }, [expanded, tx.hash]);

  return (
    <div className="tx-card" onClick={() => setExpanded(!expanded)} style={{ background: "#0D1220", border: `1px solid ${border}`, borderRadius: "8px", padding: "14px 16px", cursor: "pointer" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "8px" }}>
        <a href={`https://etherscan.io/tx/${tx.hash}`} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}
          style={{ color: "#60A5FA", textDecoration: "none", fontSize: "13px", fontFamily: "'JetBrains Mono', monospace", fontWeight: 500 }}>
          {shortHash(tx.hash)} ↗
        </a>
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          {/* Verification badge */}
          {tx.revertReason && (
            <span title={tx.contractVerified ? "Contract verified on Etherscan" : "Contract not verified"}
              style={{ fontSize: "10px", color: tx.contractVerified ? "#4FFFB0" : "#4A5568", fontFamily: "'JetBrains Mono', monospace" }}>
              {tx.contractVerified ? "✓ verified" : "unverified"}
            </span>
          )}
          <span style={{ fontSize: "11px", color: "#4A5568" }}>{formatTime(tx.timeStamp)}</span>
        </div>
      </div>

      {/* Protocol */}
      {tx.protocol && <div style={{ marginBottom: "8px" }}><span className="pill pill-protocol">{tx.protocol}</span></div>}

      {/* Outcome pill — one branch per status. */}
      <div style={{ marginBottom: "8px" }}>
        {tx.status === STATUS.DECODED && (
          <span className={`pill ${isCustomDecoded ? "pill-custom" : "pill-revert"}`}>
            {isCustomDecoded && <span style={{ marginRight: "4px", opacity: 0.7 }}>✦</span>}
            {tx.revertReason.slice(0, 72)}{tx.revertReason.length > 72 ? "..." : ""}
          </span>
        )}
        {tx.status === STATUS.UNDETERMINED && (
          <span className="pill pill-undetermined" title="We could not establish why this transaction failed">? {tx.undetermined}</span>
        )}
        {tx.status === STATUS.SILENT && (
          <span className={`pill ${isOOG ? "pill-oog" : "pill-silent"}`}>{tx.silentType}</span>
        )}
      </div>

      {/* Gas bar */}
      <div style={{ marginBottom: "6px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
          <span style={{ fontSize: "11px", color: "#4A5568", fontFamily: "'JetBrains Mono', monospace" }}>Gas</span>
          <span style={{ fontSize: "11px", color: tx.gasPercent >= 99 ? "#FF6B6B" : tx.gasPercent >= 90 ? "#FFB347" : "#4A5568", fontFamily: "'JetBrains Mono', monospace" }}>
            {tx.gasPercent}% ({tx.gasUsed.toLocaleString()} / {tx.gasLimit.toLocaleString()})
          </span>
        </div>
        <div style={{ height: "3px", background: "#1C2333", borderRadius: "2px", overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${tx.gasPercent}%`, background: tx.gasPercent >= 99 ? "#FF6B6B" : tx.gasPercent >= 90 ? "#FFB347" : "#4FFFB0", borderRadius: "2px", transition: "width 0.4s ease" }} />
        </div>
      </div>

      {/* Expanded detail panel */}
      {expanded && (
        <div style={{ marginTop: "10px", padding: "10px 12px", background: "#080C16", borderRadius: "6px", fontSize: "11px", fontFamily: "'JetBrains Mono', monospace", wordBreak: "break-all" }}>
          {/* from address */}
          <div style={{ color: "#4A5568", marginBottom: isCustomDecoded && tx.revertDecoded?.args?.length ? "10px" : 0 }}>
            <span style={{ color: "#2D3748" }}>from: </span>{tx.from}
          </div>

          {/* Decoded custom error arguments */}
          {isCustomDecoded && tx.revertDecoded?.args?.length > 0 && (
            <div style={{ marginTop: "6px" }}>
              <div style={{ color: "#4FFFB0", marginBottom: "6px", fontWeight: 600, letterSpacing: "0.04em" }}>
                {tx.revertDecoded.errorName}()
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                {tx.revertDecoded.args.map((arg, i) => (
                  <div key={i} style={{ display: "flex", gap: "8px", alignItems: "baseline" }}>
                    <span style={{ color: "#64748B", minWidth: "80px", flexShrink: 0 }}>{arg.name}</span>
                    <span style={{ color: "#A78BFA", fontSize: "10px", flexShrink: 0 }}>{arg.type}</span>
                    <span style={{ color: "#E2E8F0", wordBreak: "break-all" }}>{arg.value}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Lazy on-chain enrichment: receipt + tx-by-hash */}
          <div style={{ marginTop: "10px", borderTop: "1px solid #16202E", paddingTop: "10px" }}>
            {enrichLoading && <div style={{ color: "#4A5568" }}>Loading on-chain details…</div>}
            {enrichError && <div style={{ color: "#FF6B6B" }}>{enrichError}</div>}
            {enrich && (
              <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
                {[
                  { label: "gas burned", value: enrich.gasBurnedWei ? `${formatEth(enrich.gasBurnedWei)} ETH` : "—", color: "#FFB347" },
                  { label: "value sent", value: `${formatEth(enrich.valueWei || "0")} ETH`, color: "#E2E8F0" },
                  { label: "nonce", value: enrich.nonce ?? "—", color: "#E2E8F0" },
                  { label: "tx type", value: txTypeLabel(enrich.txType), color: "#E2E8F0" },
                  { label: "receipt", value: enrich.status === "0x0" ? "failed (0x0)" : enrich.status === "0x1" ? "success (0x1)" : "—", color: enrich.status === "0x0" ? "#FF6B6B" : "#E2E8F0" },
                ].map(({ label, value, color }) => (
                  <div key={label} style={{ display: "flex", gap: "8px", alignItems: "baseline" }}>
                    <span style={{ color: "#64748B", minWidth: "80px", flexShrink: 0 }}>{label}</span>
                    <span style={{ color, wordBreak: "break-all" }}>{value}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <div style={{ marginTop: "6px", fontSize: "11px", color: "#2D3748", textAlign: "right" }}>
        {expanded ? "▲ collapse" : "▼ expand"}
      </div>
    </div>
  );
}
