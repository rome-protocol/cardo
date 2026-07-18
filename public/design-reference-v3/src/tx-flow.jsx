/* global React */
// Transaction state machine — shared across Swap, Lend, Perps, Compose

const { useState, useEffect, useRef } = React;

// Transaction states: idle → quoting → quoted → signing → submitting → confirming → { confirmed, failed }
const TX_STATES = ["idle", "quoting", "quoted", "signing", "submitting", "confirming", "confirmed", "failed"];

// Hook: simulate a full tx lifecycle
const useTxFlow = () => {
  const [state, setState] = useState("idle");
  const [txHash, setTxHash] = useState(null);
  const timers = useRef([]);
  const reset = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setState("idle");
    setTxHash(null);
  };
  const run = (opts = {}) => {
    reset();
    const { onConfirmed, fail = false } = opts;
    // signing
    setState("signing");
    timers.current.push(setTimeout(() => {
      setState("submitting");
      timers.current.push(setTimeout(() => {
        setState("confirming");
        const hash = "0x" + Array.from({length: 64}, () => Math.floor(Math.random()*16).toString(16)).join("");
        setTxHash(hash);
        timers.current.push(setTimeout(() => {
          if (fail) { setState("failed"); }
          else { setState("confirmed"); onConfirmed && onConfirmed(hash); }
        }, 1800));
      }, 1200));
    }, 1400));
  };
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  return { state, txHash, run, reset, setState };
};

// Tx modal — step stepper for the state machine
const TxModal = ({ flow, title, summary, onClose, onRetry, steps }) => {
  if (flow.state === "idle" || flow.state === "quoting" || flow.state === "quoted") return null;

  const defaultSteps = ["signing", "submitting", "confirming", "confirmed"];
  const stateSteps = steps || defaultSteps;
  const idx = stateSteps.indexOf(flow.state);
  const failed = flow.state === "failed";
  const done = flow.state === "confirmed";

  const labels = {
    signing: "Awaiting signature",
    submitting: "Broadcasting",
    confirming: "Settling on Solana",
    confirmed: "Complete",
  };

  return (
    <div className="modal-scrim" onClick={done || failed ? onClose : null}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
          <Eyebrow>{done ? "Transaction confirmed" : failed ? "Transaction failed" : "Transaction"}</Eyebrow>
          {(done || failed) && (
            <button className="btn btn-ghost btn-sm" onClick={onClose} style={{ border: 0, padding: 4 }}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4"/></svg>
            </button>
          )}
        </div>
        <h3 className="serif" style={{ fontSize: 28, margin: "4px 0 6px", fontWeight: 400 }}>
          {done ? <><em>Done.</em></> : failed ? <><em>Couldn't submit.</em></> : title}
        </h3>
        <p className="small" style={{ color: "var(--fg2)", margin: 0, marginBottom: 20 }}>{summary}</p>

        {!failed && (
          <ol style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 2 }}>
            {stateSteps.map((s, i) => {
              const state = i < idx ? "done" : i === idx ? "active" : "pending";
              return (
                <li key={s} style={{ display: "flex", alignItems: "center", gap: 14, padding: "10px 0" }}>
                  <StepDot state={state} />
                  <span style={{ flex: 1, fontSize: 14, color: state === "pending" ? "var(--fg3)" : "var(--fg1)" }}>
                    {labels[s] || s}
                  </span>
                  {state === "active" && <span className="tiny mono" style={{ color: "var(--rome-purple)" }}>in progress…</span>}
                  {state === "done" && <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 8.5 L6.5 12 L13 4.5" stroke="#1a8e4a" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                </li>
              );
            })}
          </ol>
        )}

        {failed && (
          <div style={{ padding: 16, borderRadius: 10, background: "rgba(180,68,42,0.06)", border: "1px solid rgba(180,68,42,0.2)", marginBottom: 18 }}>
            <div className="mono" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em", color: "#8a3320", marginBottom: 8 }}>Revert · SlippageExceeded</div>
            <p style={{ margin: 0, fontSize: 13, color: "var(--fg1)" }}>
              Price moved more than 0.5% during submission. The pool oracle refreshed at block 4,991,204.
            </p>
            <p className="small" style={{ margin: "10px 0 0" }}>Suggested: raise slippage to 1.0% and retry.</p>
          </div>
        )}

        {flow.txHash && (
          <div style={{ marginTop: 18, padding: 12, background: "var(--rome-paper)", borderRadius: 10 }}>
            <div className="tiny mono" style={{ textTransform: "uppercase", letterSpacing: "0.1em" }}>Tx hash</div>
            <div className="mono" style={{ fontSize: 12, wordBreak: "break-all", marginTop: 4 }}>{flow.txHash}</div>
          </div>
        )}

        <div className="row" style={{ gap: 10, marginTop: 22 }}>
          {done && <button className="btn btn-primary btn-lg" style={{ flex: 1 }} onClick={onClose}>Done</button>}
          {done && <button className="btn btn-ghost btn-lg" onClick={() => alert("Would open /tx/" + flow.txHash)}>View receipt</button>}
          {failed && <button className="btn btn-primary btn-lg" style={{ flex: 1 }} onClick={onRetry}>Retry</button>}
          {failed && <button className="btn btn-ghost btn-lg" onClick={onClose}>Close</button>}
        </div>
      </div>
    </div>
  );
};

const StepDot = ({ state }) => {
  if (state === "done") return <span style={{ width: 20, height: 20, borderRadius: "50%", background: "rgba(26,142,74,0.14)", display: "inline-flex", alignItems: "center", justifyContent: "center" }}><span style={{ width: 8, height: 8, borderRadius: "50%", background: "#1a8e4a" }} /></span>;
  if (state === "active") return <span style={{ width: 20, height: 20, borderRadius: "50%", border: "2px solid var(--rome-purple)", borderTopColor: "transparent", animation: "spin 0.9s linear infinite" }} />;
  return <span style={{ width: 20, height: 20, borderRadius: "50%", border: "1.5px dashed var(--border-default)" }} />;
};

// CSS keyframe injection for spinner
if (typeof document !== "undefined" && !document.getElementById("cardo-kf")) {
  const s = document.createElement("style");
  s.id = "cardo-kf";
  s.textContent = "@keyframes spin { to { transform: rotate(360deg); } }";
  document.head.appendChild(s);
}

// Connect-wallet modal
const ConnectModal = ({ onConnect, onClose }) => (
  <div className="modal-scrim" onClick={onClose}>
    <div className="modal" onClick={(e) => e.stopPropagation()}>
      <Eyebrow>Connect wallet</Eyebrow>
      <h3 className="serif" style={{ fontSize: 28, margin: "6px 0 20px", fontWeight: 400 }}>
        Choose a <em>wallet</em>.
      </h3>
      {[
        { name: "MetaMask", bg: "#F6851B", letter: "🦊" },
        { name: "WalletConnect", bg: "#3B99FC", letter: "W" },
        { name: "Coinbase Wallet", bg: "#0052FF", letter: "C" },
        { name: "Safe", bg: "#12FF80", letter: "S" },
      ].map(w => (
        <button key={w.name} type="button" className="card card-hover"
          onClick={onConnect}
          style={{ width: "100%", padding: "14px 16px", display: "flex", alignItems: "center", gap: 14, marginBottom: 8, cursor: "pointer", textAlign: "left", border: "1px solid var(--border-subtle)", background: "var(--bg-surface)" }}>
          <span style={{ width: 36, height: 36, borderRadius: 10, background: w.bg, color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 16, fontWeight: 700 }}>{w.letter}</span>
          <span style={{ flex: 1, fontSize: 15, fontWeight: 500 }}>{w.name}</span>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M5 3l5 5-5 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
        </button>
      ))}
      <p className="small" style={{ marginTop: 18, color: "var(--fg2)" }}>
        Cardo requests <span className="mono" style={{ fontSize: 12 }}>eth_requestAccounts</span> and, on first tx, a network switch to Rome chain (chainId 999999).
      </p>
    </div>
  </div>
);

Object.assign(window, { useTxFlow, TxModal, ConnectModal });
