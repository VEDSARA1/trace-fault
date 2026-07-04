import { useState, useRef, useEffect } from "react";

const PROTOCOL_REGISTRY = {
  "0x111111254eeb25477b68fb85ed929f73a960582": "1inch Aggregation Router V5",
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

function decodeRevertReason(data) {
  if (!data || data === "0x") return null;
  try {
    if (data.startsWith("0x08c379a0")) {
      const hex = data.slice(10);
      const offset = parseInt(hex.slice(0, 64), 16) * 2;
      const length = parseInt(hex.slice(offset, offset + 64), 16) * 2;
      const strHex = hex.slice(offset + 64, offset + 64 + length);
      return decodeURIComponent(strHex.replace(/../g, "%$&")).replace(/[^\x20-\x7E]/g, "");
    }
    if (data.startsWith("0x4e487b71")) {
      const code = parseInt(data.slice(10, 74), 16);
      const panicMessages = {
        1: "Assertion failed", 17: "Arithmetic overflow/underflow",
        18: "Division by zero", 33: "Enum value out of range",
        34: "Incorrectly encoded storage byte array", 49: "Pop on empty array",
        50: "Array index out of bounds", 65: "Memory allocation overflow",
        81: "Zero-initialized function pointer",
      };
      return `Panic: ${panicMessages[code] || `Code ${code}`}`;
    }
    if (data.length >= 10) return `Custom error: ${data.slice(0, 10)}`;
    return null;
  } catch { return null; }
}

function classifySilentFailure(gasUsed, gasLimit) {
  const ratio = gasUsed / gasLimit;
  if (ratio >= 0.99) return "Likely OOG (Out of Gas)";
  if (ratio >= 0.95) return "Possible OOG";
  return "Bare revert() or custom error (no message)";
}

function lookupProtocol(address) {
  if (!address) return null;
  return PROTOCOL_REGISTRY[address.toLowerCase()] || null;
}

export default function App() {
  const [etherscanKey, setEtherscanKey] = useState("");
  const [contractAddress, setContractAddress] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState("");
  const [error, setError] = useState("");
  const [identified, setIdentified] = useState([]);
  const [silent, setSilent] = useState([]);
  const [analyzed, setAnalyzed] = useState(false);
  const [traceActive, setTraceActive] = useState(false);
  const traceRef = useRef(null);

  useEffect(() => {
    if (traceActive && traceRef.current) {
      traceRef.current.style.width = "0%";
      setTimeout(() => { if (traceRef.current) traceRef.current.style.width = "100%"; }, 50);
    }
  }, [traceActive]);

  async function fetchAndAnalyze() {
    setError(""); setIdentified([]); setSilent([]); setAnalyzed(false);
    if (!etherscanKey.trim()) return setError("Etherscan API key is required. Open Settings.");
    if (!contractAddress.trim() || !contractAddress.startsWith("0x") || contractAddress.length !== 42)
      return setError("Enter a valid contract address (0x + 40 hex characters).");

    setLoading(true); setTraceActive(true);
    setLoadingMsg("Fetching failed transactions from Etherscan...");

    try {
      const url = `https://api.etherscan.io/v2/api?chainid=1&module=account&action=txlist&address=${contractAddress}&startblock=0&endblock=99999999&sort=desc&page=1&offset=500&apikey=${etherscanKey}`;
      const res = await fetch(url);
      const json = await res.json();

      if (json.status === "0") {
        if (json.message === "No transactions found")
          return setError("No transactions found for this contract address.");
        throw new Error(json.result || json.message);
      }

      const failedTxs = (json.result || []).filter(tx => tx.isError === "1");
      if (failedTxs.length === 0)
        return setError("No failed transactions found in the last 500 transactions.");

      const enriched = [];
      const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
      for (let i = 0; i < Math.min(failedTxs.length, 20); i++) {
        const tx = failedTxs[i];
        setLoadingMsg(`Decoding transaction ${i + 1} of ${Math.min(failedTxs.length, 20)}...`);
        if (i > 0) await delay(250); // Rate limiting: 250ms between calls (~4 calls/sec)

        let revertReason = null;
        try {
          const blockHex = `0x${parseInt(tx.blockNumber).toString(16)}`;
          const traceUrl = `https://api.etherscan.io/v2/api?chainid=1&module=proxy&action=eth_call&to=${tx.to}&data=${tx.input}&tag=${blockHex}&apikey=${etherscanKey}`;
          const traceRes = await fetch(traceUrl);
          const traceJson = await traceRes.json();
          if (traceJson.result === null && traceJson.error?.message?.includes("rate")) {
            console.warn(`Rate limited on tx ${tx.hash}`);
            revertReason = null;
          } else if (traceJson.error?.data) {
            revertReason = decodeRevertReason(traceJson.error.data);
          }
        } catch (e) { console.warn(`Trace error for tx ${tx.hash}:`, e.message); }

        const gasUsed = parseInt(tx.gasUsed);
        const gasLimit = parseInt(tx.gas);
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
          revertReason,
          silentType: !revertReason ? classifySilentFailure(gasUsed, gasLimit) : null,
          timeStamp: tx.timeStamp,
        });
      }

      setIdentified(enriched.filter(tx => tx.revertReason));
      setSilent(enriched.filter(tx => !tx.revertReason));
      setAnalyzed(true);
    } catch (err) {
      setError(`Error: ${err.message}`);
    } finally {
      setLoading(false); setTraceActive(false);
    }
  }

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
        <button className="btn-settings" onClick={() => setShowSettings(!showSettings)} style={{ background: showSettings ? "#1C2333" : "transparent", border: "1px solid #2D3748", color: "#8892A4", padding: "6px 14px", borderRadius: "6px", cursor: "pointer", fontSize: "13px", display: "flex", alignItems: "center", gap: "6px" }}>
          <span>⚙</span> API Key
        </button>
      </div>

      {/* Trace bar */}
      <div style={{ height: "2px", background: "#0D1220", overflow: "hidden" }}>
        <div ref={traceRef} className="trace-bar" style={{ width: "0%" }} />
      </div>

      {/* Settings drawer */}
      {showSettings && (
        <div style={{ background: "#0D1220", borderBottom: "1px solid #1C2333", padding: "20px 24px", display: "flex", gap: "16px", alignItems: "flex-end", flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: "260px" }}>
            <label style={{ fontSize: "11px", color: "#4FFFB0", fontFamily: "'JetBrains Mono', monospace", letterSpacing: "0.08em", display: "block", marginBottom: "6px" }}>
              ETHERSCAN API KEY
            </label>
            <input
              type="password"
              value={etherscanKey}
              onChange={e => setEtherscanKey(e.target.value)}
              placeholder="Paste your Etherscan key..."
              style={{ width: "100%", background: "#0A0E1A", border: "1px solid #2D3748", color: "#E2E8F0", padding: "8px 12px", borderRadius: "6px", fontSize: "13px", fontFamily: "'JetBrains Mono', monospace" }}
            />
            <p style={{ fontSize: "11px", color: "#4A5568", marginTop: "4px" }}>Free key available at etherscan.io/apis</p>
          </div>
          <button onClick={() => setShowSettings(false)} style={{ background: "#4FFFB0", color: "#0A0E1A", border: "none", padding: "8px 18px", borderRadius: "6px", cursor: "pointer", fontSize: "13px", fontWeight: 600 }}>
            Save & Close
          </button>
        </div>
      )}

      {/* Main */}
      <div style={{ maxWidth: "1100px", margin: "0 auto", padding: "32px 24px" }}>
        <div style={{ marginBottom: "28px" }}>
          <h1 style={{ fontSize: "26px", fontWeight: 600, color: "#F1F5F9", fontFamily: "'JetBrains Mono', monospace", letterSpacing: "-0.5px", marginBottom: "8px" }}>
            Failed Transaction Analyzer
          </h1>
          <p style={{ fontSize: "14px", color: "#64748B", maxWidth: "520px", lineHeight: "1.6" }}>
            Enter a contract address to fetch its failed transactions, decode revert reasons, and classify silent failures.
          </p>
        </div>

        {/* Input */}
        <div style={{ display: "flex", gap: "12px", marginBottom: "12px", flexWrap: "wrap" }}>
          <input
            value={contractAddress}
            onChange={e => setContractAddress(e.target.value)}
            onKeyDown={e => e.key === "Enter" && fetchAndAnalyze()}
            placeholder="0x contract address (e.g. 1inch Router, Seaport...)"
            style={{ flex: 1, minWidth: "280px", background: "#0D1220", border: "1px solid #2D3748", color: "#E2E8F0", padding: "11px 16px", borderRadius: "8px", fontSize: "14px", fontFamily: "'JetBrains Mono', monospace" }}
          />
          <button className="btn-primary" onClick={fetchAndAnalyze} disabled={loading} style={{ background: loading ? "#2D3748" : "#4FFFB0", color: loading ? "#8892A4" : "#0A0E1A", border: "none", padding: "11px 24px", borderRadius: "8px", cursor: loading ? "not-allowed" : "pointer", fontSize: "14px", fontWeight: 600, whiteSpace: "nowrap", transition: "background 0.2s" }}>
            {loading ? "Analyzing..." : "Analyze Contract →"}
          </button>
        </div>

        {/* Quick fill */}
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "24px" }}>
          {[
            ["1inch V6", "0x111111125421ca6dc452d289314280a0f8842a65"],
            ["Seaport 1.6", "0x0000000000000068F116a894984e2DB1123eB395"],
            ["Uniswap V3", "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45"],
            ["Aave V3", "0x87870Bca3F3fD6335C3F4CE8392D69350B4fA4E2"],
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
            {/* Summary */}
            <div style={{ display: "flex", gap: "16px", marginBottom: "28px", flexWrap: "wrap" }}>
              {[
                { label: "Total Failed", value: identified.length + silent.length, color: "#E2E8F0" },
                { label: "Decoded Failures", value: identified.length, color: "#4FFFB0" },
                { label: "Silent Failures", value: silent.length, color: "#FF6B6B" },
              ].map(({ label, value, color }) => (
                <div key={label} style={{ background: "#0D1220", border: "1px solid #1C2333", borderRadius: "8px", padding: "14px 20px", minWidth: "140px" }}>
                  <div style={{ fontSize: "24px", fontWeight: 600, color, fontFamily: "'JetBrains Mono', monospace" }}>{value}</div>
                  <div style={{ fontSize: "12px", color: "#4A5568", marginTop: "2px" }}>{label}</div>
                </div>
              ))}
            </div>

            {/* Two columns */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "24px" }}>
              {[
                { bucket: identified, type: "decoded", label: "DECODED FAILURES", dot: "#4FFFB0", border: "#1A2E3A" },
                { bucket: silent, type: "silent", label: "SILENT FAILURES", dot: "#FF6B6B", border: "#2D1515" },
              ].map(({ bucket, type, label, dot, border }) => (
                <div key={type}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "16px" }}>
                    <div style={{ width: "8px", height: "8px", borderRadius: "50%", background: dot }} />
                    <span style={{ fontSize: "13px", fontWeight: 600, color: dot, fontFamily: "'JetBrains Mono', monospace", letterSpacing: "0.05em" }}>{label}</span>
                    <span style={{ fontSize: "12px", color: "#4A5568" }}>({bucket.length})</span>
                  </div>
                  {bucket.length === 0
                    ? <div style={{ color: "#4A5568", fontSize: "13px", padding: "20px 0" }}>No {type} failures found.</div>
                    : <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                        {bucket.map(tx => <TxCard key={tx.hash} tx={tx} border={border} shortHash={shortHash} formatTime={formatTime} />)}
                      </div>
                  }
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Empty state */}
        {!analyzed && !loading && !error && (
          <div style={{ textAlign: "center", padding: "60px 20px", border: "1px dashed #1C2333", borderRadius: "12px" }}>
            <div style={{ fontSize: "32px", marginBottom: "12px", opacity: 0.4 }}>⬡</div>
            <p style={{ color: "#4A5568", fontSize: "14px" }}>Enter a contract address and your Etherscan API key to begin.</p>
            <p style={{ color: "#2D3748", fontSize: "12px", marginTop: "6px", fontFamily: "'JetBrains Mono', monospace" }}>Scans 500 transactions, analyzes up to 20 failed ones</p>
          </div>
        )}
      </div>
    </div>
  );
}

function TxCard({ tx, border, shortHash, formatTime }) {
  const [expanded, setExpanded] = useState(false);
  const isOOG = tx.silentType?.includes("OOG");

  return (
    <div className="tx-card" onClick={() => setExpanded(!expanded)} style={{ background: "#0D1220", border: `1px solid ${border}`, borderRadius: "8px", padding: "14px 16px", cursor: "pointer" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "8px" }}>
        <a href={`https://etherscan.io/tx/${tx.hash}`} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}
          style={{ color: "#60A5FA", textDecoration: "none", fontSize: "13px", fontFamily: "'JetBrains Mono', monospace", fontWeight: 500 }}>
          {shortHash(tx.hash)} ↗
        </a>
        <span style={{ fontSize: "11px", color: "#4A5568" }}>{formatTime(tx.timeStamp)}</span>
      </div>

      {/* Protocol */}
      {tx.protocol && <div style={{ marginBottom: "8px" }}><span className="pill pill-protocol">{tx.protocol}</span></div>}

      {/* Revert / silent */}
      <div style={{ marginBottom: "8px" }}>
        {tx.revertReason
          ? <span className="pill pill-revert">{tx.revertReason.slice(0, 60)}{tx.revertReason.length > 60 ? "..." : ""}</span>
          : <span className={`pill ${isOOG ? "pill-oog" : "pill-silent"}`}>{tx.silentType}</span>
        }
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

      {/* Expanded: from address */}
      {expanded && (
        <div style={{ marginTop: "10px", padding: "10px 12px", background: "#080C16", borderRadius: "6px", fontSize: "11px", color: "#4A5568", fontFamily: "'JetBrains Mono', monospace", wordBreak: "break-all" }}>
          <span style={{ color: "#2D3748" }}>from: </span>{tx.from}
        </div>
      )}

      <div style={{ marginTop: "6px", fontSize: "11px", color: "#2D3748", textAlign: "right" }}>
        {expanded ? "▲ collapse" : "▼ expand"}
      </div>
    </div>
  );
}
