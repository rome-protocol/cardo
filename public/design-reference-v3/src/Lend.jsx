/* global React, Roman, Eyebrow, TokenLogo, ProtocolChip, useLivePrice, useTxFlow, TxModal, fmtUSD, fmtPct, fmtNum */

const { useState } = React;

const RESERVES = [
  { sym: "USDC", name: "USD Coin", supplyApy: 8.24, borrowApy: 11.4, totalSupplied: 24_800_000, totalBorrowed: 17_900_000, ltv: 0.82, liqThresh: 0.88, price: 1, util: 72 },
  { sym: "SOL",  name: "Solana",   supplyApy: 5.12, borrowApy: 8.6,  totalSupplied: 142_000,   totalBorrowed: 78_400,    ltv: 0.75, liqThresh: 0.82, price: 149.22, util: 55 },
  { sym: "BTC",  name: "Bitcoin",  supplyApy: 0.41, borrowApy: 2.8,  totalSupplied: 68,        totalBorrowed: 12,        ltv: 0.70, liqThresh: 0.78, price: 71440, util: 18 },
  { sym: "JTO",  name: "Jito",     supplyApy: 0,    borrowApy: 0,    totalSupplied: 0,         totalBorrowed: 0,         ltv: 0,    liqThresh: 0, price: 2.8, util: 0, pending: true },
];

const Lend = ({ wallet, onConnect }) => {
  const [selected, setSelected] = useState(null);
  const [mode, setMode] = useState("supply"); // supply | borrow | withdraw | repay
  const [amount, setAmount] = useState("");
  const flow = useTxFlow();

  const position = wallet.connected ? {
    supplied: [{ sym: "USDC", amt: 2500, earned: 42.80 }],
    borrowed: [{ sym: "SOL", amt: 2.1, interest: 0.014 }],
  } : null;

  const suppliedUSD = position ? position.supplied.reduce((s,p) => s + p.amt * (RESERVES.find(r=>r.sym===p.sym)?.price || 1), 0) : 0;
  const borrowedUSD = position ? position.borrowed.reduce((s,p) => s + p.amt * (RESERVES.find(r=>r.sym===p.sym)?.price || 1), 0) : 0;
  const health = suppliedUSD > 0 ? (suppliedUSD * 0.85) / borrowedUSD : 99;
  const netApy = 6.1;

  const open = (r, m) => { setSelected(r); setMode(m); setAmount(""); };

  return (
    <main className="container" style={{ padding: "40px 32px 96px" }}>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 28, alignItems: "flex-end", flexWrap: "wrap", gap: 16 }}>
        <div>
          <Eyebrow>Cardo Lend · Kamino reserves</Eyebrow>
          <h1 className="h2" style={{ marginTop: 6 }}>Supply, borrow <em>against Solana liquidity.</em></h1>
        </div>
        <div className="row" style={{ gap: 20 }}>
          <Stat k="Total supplied" v={fmtUSD(24_800_000 + 142_000*149.22 + 68*71440, { compact: true, decimals: 1 })} />
          <Stat k="Total borrowed" v={fmtUSD(17_900_000 + 78_400*149.22 + 12*71440, { compact: true, decimals: 1 })} />
          <Stat k="Active reserves" v="III" serif />
        </div>
      </div>

      {/* Positions */}
      {position && (
        <div className="card" style={{ padding: 22, marginBottom: 28, background: "linear-gradient(180deg, rgba(213,211,234,0.3) 0%, var(--bg-surface) 60%)" }}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 20 }}>
            <div>
              <Eyebrow>Your position</Eyebrow>
              <div className="row" style={{ gap: 32, marginTop: 10 }}>
                <div>
                  <div className="tiny">Net worth</div>
                  <div className="serif" style={{ fontSize: 32, letterSpacing: "-0.01em" }}>{fmtUSD(suppliedUSD - borrowedUSD)}</div>
                </div>
                <div className="divider-v" style={{ alignSelf: "stretch" }} />
                <div>
                  <div className="tiny">Net APY</div>
                  <div className="mono" style={{ fontSize: 22, color: "#1a8e4a" }}>+{fmtPct(netApy)}</div>
                </div>
                <div className="divider-v" style={{ alignSelf: "stretch" }} />
                <div style={{ minWidth: 200 }}>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <span className="tiny">Health factor</span>
                    <span className="mono" style={{ fontSize: 13, fontWeight: 600, color: health > 2 ? "#1a8e4a" : health > 1.3 ? "#c69f1f" : "#b4442a" }}>{health.toFixed(2)}</span>
                  </div>
                  <div className="health-bar" style={{ marginTop: 8 }}>
                    <div className="health-fill" style={{
                      width: Math.min(100, (health/3)*100) + "%",
                      background: health > 2 ? "#1a8e4a" : health > 1.3 ? "#c69f1f" : "#b4442a",
                    }} />
                  </div>
                  <div className="tiny" style={{ marginTop: 4 }}>Liquidation at health &lt; 1.0</div>
                </div>
              </div>
            </div>
            <ProtocolChip p="kamino" size="lg" />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 22 }}>
            <div>
              <div className="eyebrow" style={{ marginBottom: 10 }}>Supplied</div>
              {position.supplied.map(p => (
                <div key={p.sym} className="row" style={{ padding: "12px 0", borderTop: "1px solid var(--border-subtle)" }}>
                  <TokenLogo symbol={p.sym} size={28} />
                  <div style={{ marginLeft: 10, flex: 1 }}>
                    <div>{fmtNum(p.amt)} {p.sym}</div>
                    <div className="tiny">Earned <span className="mono">+{fmtUSD(p.earned)}</span></div>
                  </div>
                  <button className="btn btn-ghost btn-sm" onClick={() => open(RESERVES.find(r => r.sym === p.sym), "withdraw")}>Withdraw</button>
                </div>
              ))}
            </div>
            <div>
              <div className="eyebrow" style={{ marginBottom: 10 }}>Borrowed</div>
              {position.borrowed.map(p => (
                <div key={p.sym} className="row" style={{ padding: "12px 0", borderTop: "1px solid var(--border-subtle)" }}>
                  <TokenLogo symbol={p.sym} size={28} />
                  <div style={{ marginLeft: 10, flex: 1 }}>
                    <div>{fmtNum(p.amt)} {p.sym}</div>
                    <div className="tiny">Interest accrued <span className="mono">{fmtNum(p.interest,4)} {p.sym}</span></div>
                  </div>
                  <button className="btn btn-ghost btn-sm" onClick={() => open(RESERVES.find(r => r.sym === p.sym), "repay")}>Repay</button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Markets */}
      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ padding: "18px 24px", borderBottom: "1px solid var(--border-subtle)" }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <Eyebrow>Reserves on Kamino</Eyebrow>
            <span className="tiny">APYs updated 4s ago</span>
          </div>
        </div>
        <table className="tbl">
          <thead>
            <tr>
              <th>Asset</th>
              <th className="right">Supply APY</th>
              <th className="right">Borrow APY</th>
              <th className="right">Supplied</th>
              <th className="right">Utilization</th>
              <th className="right">LTV</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {RESERVES.map(r => (
              <tr key={r.sym} onClick={() => !r.pending && open(r, "supply")} style={{ opacity: r.pending ? 0.55 : 1, cursor: r.pending ? "default" : "pointer" }}>
                <td>
                  <div className="row">
                    <TokenLogo symbol={r.sym} size={30} />
                    <div style={{ marginLeft: 10 }}>
                      <div style={{ fontWeight: 500 }}>{r.sym}</div>
                      <div className="tiny">{r.name}</div>
                    </div>
                  </div>
                </td>
                <td className="num-cell right" style={{ color: "#1a8e4a", fontWeight: 500 }}>{r.pending ? "—" : fmtPct(r.supplyApy)}</td>
                <td className="num-cell right">{r.pending ? "—" : fmtPct(r.borrowApy)}</td>
                <td className="num-cell right">{r.pending ? "—" : fmtUSD(r.totalSupplied * r.price, { compact: true, decimals: 1 })}</td>
                <td className="right" style={{ minWidth: 120 }}>
                  {r.pending ? "—" : (
                    <div className="row" style={{ justifyContent: "flex-end", gap: 10 }}>
                      <span className="mono num" style={{ fontSize: 12 }}>{r.util}%</span>
                      <div className="health-bar" style={{ width: 60 }}>
                        <div className="health-fill" style={{ width: r.util + "%", background: r.util > 80 ? "#c69f1f" : "var(--rome-purple)" }} />
                      </div>
                    </div>
                  )}
                </td>
                <td className="num-cell right">{r.pending ? "—" : fmtPct(r.ltv*100, 0)}</td>
                <td className="right">
                  {r.pending ? (
                    <span className="badge">Registration pending</span>
                  ) : (
                    <div className="row" style={{ gap: 6, justifyContent: "flex-end" }}>
                      <button className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); open(r, "supply"); }}>Supply</button>
                      <button className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); open(r, "borrow"); }}>Borrow</button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ padding: "14px 24px", borderTop: "1px solid var(--border-subtle)", background: "var(--rome-paper)" }}>
          <p className="small" style={{ margin: 0, fontSize: 12.5 }}>
            Each reserve must be pre-registered on the Kamino adapter. New reserves are added periodically.
            <a href="#" style={{ marginLeft: 6, color: "var(--rome-purple)" }}>Request a reserve →</a>
          </p>
        </div>
      </div>

      {selected && (
        <LendDrawer reserve={selected} mode={mode} setMode={setMode} amount={amount} setAmount={setAmount}
          onClose={() => setSelected(null)} wallet={wallet} onConnect={onConnect} flow={flow} position={position} />
      )}

      <TxModal flow={flow} onClose={() => { flow.reset(); setSelected(null); }} onRetry={() => flow.run()}
        title={selected && <><em>{mode === "supply" ? "Supplying" : mode === "borrow" ? "Borrowing" : mode === "repay" ? "Repaying" : "Withdrawing"}</em> {amount || "0"} {selected.sym}</>}
        summary="Via Kamino Lend · Cardo adapter 0x55C5…77bd" />
    </main>
  );
};

const Stat = ({ k, v, serif }) => (
  <div>
    <div className="tiny" style={{ textTransform: "uppercase", letterSpacing: "0.12em" }}>{k}</div>
    <div className={serif ? "numeral" : "mono"} style={{ fontSize: serif ? 28 : 20, marginTop: 2 }}>{v}</div>
  </div>
);

const LendDrawer = ({ reserve, mode, setMode, amount, setAmount, onClose, wallet, onConnect, flow, position }) => {
  const a = parseFloat(amount) || 0;
  const usd = a * reserve.price;
  const modes = [
    { k: "supply", label: "Supply" }, { k: "borrow", label: "Borrow" },
    { k: "withdraw", label: "Withdraw" }, { k: "repay", label: "Repay" },
  ];
  const apy = mode === "supply" ? reserve.supplyApy : reserve.borrowApy;
  const projected = mode === "supply" ? usd * (apy/100) : -usd * (apy/100);

  const onExec = () => {
    if (!wallet.connected) { onConnect(); return; }
    if (a <= 0) return;
    flow.run();
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520, padding: 0 }}>
        <div style={{ padding: "22px 26px", borderBottom: "1px solid var(--border-subtle)" }}>
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
            <div className="row">
              <TokenLogo symbol={reserve.sym} size={36} />
              <div style={{ marginLeft: 12 }}>
                <div className="serif" style={{ fontSize: 22 }}>{reserve.sym} · {reserve.name}</div>
                <ProtocolChip p="kamino" />
              </div>
            </div>
            <button className="btn btn-ghost btn-sm" onClick={onClose} style={{ padding: 6, border: 0 }}>
              <svg width="14" height="14" viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4"/></svg>
            </button>
          </div>
        </div>
        <div style={{ padding: "0 26px", borderBottom: "1px solid var(--border-subtle)" }}>
          <div className="row" style={{ gap: 2 }}>
            {modes.map(m => (
              <button key={m.k} type="button" onClick={() => setMode(m.k)}
                style={{ padding: "14px 4px", fontSize: 13, fontFamily: "var(--font-sans)", color: mode === m.k ? "var(--rome-purple)" : "var(--fg2)",
                  borderBottom: "2px solid " + (mode === m.k ? "var(--rome-purple)" : "transparent"),
                  background: "transparent", border: 0, borderBottomWidth: 2, borderBottomStyle: "solid",
                  borderBottomColor: mode === m.k ? "var(--rome-purple)" : "transparent",
                  marginRight: 20, cursor: "pointer", fontWeight: mode === m.k ? 600 : 400 }}>
                {m.label}
              </button>
            ))}
          </div>
        </div>
        <div style={{ padding: 26 }}>
          <Eyebrow>Amount</Eyebrow>
          <div className="row" style={{ alignItems: "flex-end", gap: 14, marginTop: 6 }}>
            <input className="amount-input" placeholder="0.00" value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
              style={{ fontSize: 38 }} />
            <div style={{ textAlign: "right" }}>
              <div className="mono" style={{ fontSize: 14 }}>{reserve.sym}</div>
              <div className="tiny">{fmtUSD(usd)}</div>
            </div>
          </div>
          <div className="row" style={{ marginTop: 10, justifyContent: "space-between" }}>
            <span className="tiny">Wallet: <span className="mono" style={{ color: "var(--fg1)" }}>
              {mode === "supply" || mode === "repay" ? (reserve.sym === "USDC" ? "5,420.18" : "3.214") : (mode === "borrow" ? "borrowable 1,842.00" : "supplied 2,500.00")}
            </span></span>
            <button className="chip" onClick={() => setAmount("1000")}>MAX</button>
          </div>

          <div style={{ marginTop: 22 }}>
            <div className="kv"><span className="k">{mode === "supply" ? "Supply APY" : mode === "borrow" ? "Borrow APY" : "Rate"}</span><span className="v">{fmtPct(apy)}</span></div>
            <div className="kv"><span className="k">Projected · 1 year</span><span className="v" style={{ color: projected > 0 ? "#1a8e4a" : "#8a3320" }}>
              {projected > 0 ? "+" : ""}{fmtUSD(projected)}
            </span></div>
            <div className="kv"><span className="k">Kamino fee</span><span className="v">0 bps</span></div>
            <div className="kv"><span className="k">Rent · obligation PDA</span><span className="v">{position ? "exists · $0.00" : "$0.038 (first time)"}</span></div>
            <div className="kv"><span className="k">Solana CU</span><span className="v">180,000</span></div>
            <div className="kv"><span className="k">EVM gas · Rome</span><span className="v">$0.009</span></div>
            <div className="kv kv-total"><span className="k">Total cost</span><span className="v">{fmtUSD(position ? 0.009 : 0.047)}</span></div>
          </div>

          {mode === "borrow" && (
            <div style={{ marginTop: 14, padding: 14, borderRadius: 10, background: "rgba(198,159,31,0.08)", border: "1px solid rgba(198,159,31,0.25)" }}>
              <div className="eyebrow" style={{ color: "#8a6a10", marginBottom: 4 }}>After this borrow</div>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span className="small">New health factor</span>
                <span className="mono" style={{ fontWeight: 600, color: "#c69f1f" }}>1.42 → 1.18</span>
              </div>
              <div className="row" style={{ justifyContent: "space-between", marginTop: 4 }}>
                <span className="small">Liquidation SOL price</span>
                <span className="mono">$118.40</span>
              </div>
            </div>
          )}

          <button className="btn btn-primary btn-xl" style={{ marginTop: 22 }} onClick={onExec}
            disabled={wallet.connected && a <= 0}>
            {!wallet.connected ? "Connect wallet" : a <= 0 ? "Enter an amount" : `${modes.find(m=>m.k===mode).label} ${reserve.sym}`}
          </button>
          <div className="row" style={{ marginTop: 12, justifyContent: "center" }}>
            <span className="badge badge-atomic">Atomic · one signature</span>
          </div>
        </div>
      </div>
    </div>
  );
};

Object.assign(window, { Lend });
