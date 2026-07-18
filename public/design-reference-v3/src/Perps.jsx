/* global React, Roman, Eyebrow, TokenLogo, ProtocolChip, Sparkline, useLivePrice, useTxFlow, TxModal, fmtUSD, fmtPct, fmtNum */

const { useState, useEffect, useMemo } = React;

const MARKETS = [
  { idx: 0, sym: "SOL-PERP",  base: "SOL",  mark: 149.22, change: 2.14, funding: 0.0128, oi: 48_200_000, volume: 124_000_000, maxLev: 20 },
  { idx: 1, sym: "BTC-PERP",  base: "BTC",  mark: 71440,  change: -0.42, funding: 0.0089, oi: 182_000_000, volume: 642_000_000, maxLev: 20 },
  { idx: 2, sym: "ETH-PERP",  base: "ETH",  mark: 3412.8, change: 1.62, funding: 0.011, oi: 94_000_000, volume: 281_000_000, maxLev: 20 },
  { idx: 3, sym: "JUP-PERP",  base: "JUP",  mark: 0.724, change: -3.10, funding: -0.0042, oi: 8_200_000, volume: 32_000_000, maxLev: 10 },
  { idx: 4, sym: "JTO-PERP",  base: "JTO",  mark: 2.84,  change: 4.42, funding: 0.021, oi: 12_000_000, volume: 48_000_000, maxLev: 10 },
];

const genCandles = (base, n = 48) => {
  const out = []; let p = base;
  for (let i = 0; i < n; i++) {
    const drift = (Math.random() - 0.5) * base * 0.01;
    p = Math.max(base * 0.9, Math.min(base * 1.1, p + drift));
    out.push(p);
  }
  return out;
};

const Perps = ({ wallet, onConnect }) => {
  const [marketIdx, setMarketIdx] = useState(0);
  const [side, setSide] = useState("long");
  const [orderType, setOrderType] = useState("market");
  const [size, setSize] = useState("1.0");
  const [leverage, setLeverage] = useState(5);
  const [limitPrice, setLimitPrice] = useState("");
  const flow = useTxFlow();

  const market = MARKETS[marketIdx];
  const livePrice = useLivePrice(market.mark, 0.002);
  const candles = useMemo(() => genCandles(market.mark), [marketIdx]);

  const notional = (parseFloat(size) || 0) * livePrice;
  const collateral = notional / leverage;
  const liqPrice = side === "long"
    ? livePrice * (1 - 1/leverage * 0.95)
    : livePrice * (1 + 1/leverage * 0.95);

  const positions = wallet.connected ? [
    { market: "SOL-PERP", side: "long", size: 2.5, entry: 144.20, mark: livePrice, margin: 72, pnl: (livePrice - 144.20) * 2.5, pnlPct: ((livePrice - 144.20) / 144.20) * 100 },
    { market: "ETH-PERP", side: "short", size: 0.5, entry: 3456, mark: 3412.8, margin: 130, pnl: (3456 - 3412.8) * 0.5, pnlPct: ((3456 - 3412.8) / 3456) * 100 },
  ] : [];

  const onSubmit = () => {
    if (!wallet.connected) return onConnect();
    if (!parseFloat(size)) return;
    flow.run();
  };

  return (
    <main style={{ padding: "24px 24px 96px", maxWidth: 1720, margin: "0 auto" }}>
      {/* Market header strip */}
      <div className="row" style={{ gap: 0, borderTop: "1px solid var(--border-subtle)", borderBottom: "1px solid var(--border-subtle)", overflowX: "auto", marginBottom: 18 }}>
        {MARKETS.map((m, i) => (
          <button key={m.sym} type="button" onClick={() => setMarketIdx(i)}
            style={{ flex: "1 1 auto", minWidth: 180, padding: "14px 18px", textAlign: "left",
              background: i === marketIdx ? "var(--rome-paper)" : "transparent",
              borderRight: "1px solid var(--border-subtle)",
              borderBottom: i === marketIdx ? "2px solid var(--rome-purple)" : "2px solid transparent",
              border: 0, borderBottom: i === marketIdx ? "2px solid var(--rome-purple)" : "2px solid transparent",
              cursor: "pointer" }}>
            <div className="row" style={{ gap: 8 }}>
              <TokenLogo symbol={m.base} size={22} />
              <div>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{m.sym}</div>
                <div className="num" style={{ fontSize: 14, color: "var(--fg1)" }}>
                  ${i === marketIdx ? livePrice.toFixed(2) : m.mark.toFixed(m.mark < 10 ? 4 : 2)}
                  <span style={{ marginLeft: 8, fontSize: 11, color: m.change >= 0 ? "#1a8e4a" : "#b4442a" }}>{m.change >= 0 ? "+" : ""}{m.change.toFixed(2)}%</span>
                </div>
              </div>
            </div>
          </button>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 380px", gap: 20, alignItems: "flex-start" }}>
        {/* Left: chart + positions */}
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          {/* Chart card */}
          <div className="card" style={{ padding: 0, overflow: "hidden" }}>
            <div style={{ padding: "18px 22px", borderBottom: "1px solid var(--border-subtle)" }}>
              <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 14 }}>
                <div>
                  <div className="row" style={{ gap: 12, alignItems: "center" }}>
                    <TokenLogo symbol={market.base} size={32} />
                    <div>
                      <h2 className="serif" style={{ margin: 0, fontSize: 24, fontWeight: 500 }}>{market.sym}</h2>
                      <ProtocolChip p="drift" />
                    </div>
                  </div>
                </div>
                <div className="row" style={{ gap: 28, flexWrap: "wrap" }}>
                  <MiniStat k="Mark" v={`$${livePrice.toFixed(2)}`} big />
                  <MiniStat k="24h change" v={`${market.change >= 0 ? "+" : ""}${market.change.toFixed(2)}%`} color={market.change >= 0 ? "#1a8e4a" : "#b4442a"} />
                  <MiniStat k="Funding · 1h" v={`${market.funding >= 0 ? "+" : ""}${(market.funding*100).toFixed(4)}%`} mono />
                  <MiniStat k="Open interest" v={fmtUSD(market.oi, { compact: true })} />
                  <MiniStat k="24h volume" v={fmtUSD(market.volume, { compact: true })} />
                </div>
              </div>
            </div>

            <div style={{ padding: 0, position: "relative", height: 360, background: "linear-gradient(180deg, var(--bg-surface) 0%, var(--rome-stone-50) 100%)" }}>
              <ChartSVG candles={candles} />
            </div>
          </div>

          {/* Positions */}
          <div className="card" style={{ padding: 0, overflow: "hidden" }}>
            <div style={{ padding: "14px 22px", borderBottom: "1px solid var(--border-subtle)" }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <Eyebrow>Positions · {positions.length}</Eyebrow>
                <span className="tiny">Max 5 open positions · Rome atomic tx budget</span>
              </div>
            </div>
            {positions.length === 0 ? (
              <div style={{ padding: "48px 22px", textAlign: "center" }}>
                <p className="serif italic" style={{ fontSize: 20, color: "var(--fg2)", margin: 0 }}>No open positions.</p>
                <p className="small" style={{ color: "var(--fg3)", marginTop: 4 }}>Connect a wallet to begin.</p>
              </div>
            ) : (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Market</th><th>Side</th><th className="right">Size</th><th className="right">Entry / Mark</th><th className="right">Margin</th><th className="right">PnL</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((p, i) => (
                    <tr key={i}>
                      <td style={{ fontWeight: 500 }}>{p.market}</td>
                      <td>
                        <span className="side-pill" data-side={p.side}>{p.side === "long" ? "Long" : "Short"}</span>
                      </td>
                      <td className="num-cell right">{fmtNum(p.size, 4)}</td>
                      <td className="num-cell right">
                        ${p.entry.toFixed(2)} <span style={{ color: "var(--fg3)" }}>/</span> ${p.mark.toFixed(2)}
                      </td>
                      <td className="num-cell right">{fmtUSD(p.margin)}</td>
                      <td className="num-cell right" style={{ color: p.pnl >= 0 ? "#1a8e4a" : "#b4442a", fontWeight: 500 }}>
                        {p.pnl >= 0 ? "+" : ""}{fmtUSD(p.pnl)} <span style={{ fontSize: 11, opacity: 0.7 }}>({p.pnlPct.toFixed(2)}%)</span>
                      </td>
                      <td className="right">
                        <button className="btn btn-ghost btn-sm">Close</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Right: order form */}
        <div className="card" style={{ padding: 0, position: "sticky", top: 96 }}>
          <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border-subtle)" }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <Eyebrow>Order · {market.sym}</Eyebrow>
              <span className="tiny mono" style={{ color: "var(--rome-purple)" }}>via drift</span>
            </div>
          </div>

          {/* Side toggle */}
          <div style={{ padding: "16px 20px 0", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <button type="button" onClick={() => setSide("long")} className="side-btn" data-active={side === "long"} data-side="long">
              Long
            </button>
            <button type="button" onClick={() => setSide("short")} className="side-btn" data-active={side === "short"} data-side="short">
              Short
            </button>
          </div>

          {/* Order type */}
          <div style={{ padding: "14px 20px 0" }}>
            <div className="row" style={{ gap: 2, borderBottom: "1px solid var(--border-subtle)" }}>
              {["market", "limit"].map(ot => (
                <button key={ot} type="button" onClick={() => setOrderType(ot)}
                  style={{ padding: "10px 0", marginRight: 24, fontSize: 13, textTransform: "capitalize", fontWeight: orderType === ot ? 600 : 400, color: orderType === ot ? "var(--rome-purple)" : "var(--fg2)",
                    background: "transparent", border: 0, borderBottom: "2px solid " + (orderType === ot ? "var(--rome-purple)" : "transparent"), cursor: "pointer" }}>
                  {ot}
                </button>
              ))}
            </div>
          </div>

          <div style={{ padding: "18px 20px 0" }}>
            {orderType === "limit" && (
              <>
                <Eyebrow>Limit price</Eyebrow>
                <div className="input-group" style={{ marginTop: 6, marginBottom: 14 }}>
                  <input className="amount-input-sm" type="text" placeholder={livePrice.toFixed(2)} value={limitPrice} onChange={(e) => setLimitPrice(e.target.value.replace(/[^0-9.]/g, ""))} />
                  <span className="input-suffix">USD</span>
                </div>
              </>
            )}

            <Eyebrow>Size</Eyebrow>
            <div className="input-group" style={{ marginTop: 6 }}>
              <input className="amount-input-sm" type="text" placeholder="0.00" value={size} onChange={(e) => setSize(e.target.value.replace(/[^0-9.]/g, ""))} />
              <span className="input-suffix">{market.base}</span>
            </div>
            <div className="row" style={{ justifyContent: "space-between", marginTop: 8 }}>
              <span className="tiny">≈ {fmtUSD(notional)}</span>
              <div className="row" style={{ gap: 4 }}>
                {[25, 50, 75, 100].map(p => (
                  <button key={p} className="chip chip-xs" onClick={() => setSize(((parseFloat(size) || 0) * 0 + p/100 * 10).toFixed(2))}>{p}%</button>
                ))}
              </div>
            </div>

            {/* Leverage */}
            <div style={{ marginTop: 18 }}>
              <div className="row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
                <Eyebrow>Leverage</Eyebrow>
                <span className="mono" style={{ fontSize: 13, color: "var(--rome-purple)", fontWeight: 600 }}>{leverage}×</span>
              </div>
              <input type="range" min={1} max={market.maxLev} step={1} value={leverage}
                onChange={(e) => setLeverage(Number(e.target.value))} className="lev-slider" />
              <div className="row" style={{ justifyContent: "space-between", marginTop: 4 }}>
                <span className="tiny">1×</span>
                <span className="tiny">{market.maxLev}×</span>
              </div>
            </div>
          </div>

          {/* Summary */}
          <div style={{ padding: "16px 20px", marginTop: 16, borderTop: "1px solid var(--border-subtle)", background: "var(--rome-paper)" }}>
            <div className="kv"><span className="k">Entry (est.)</span><span className="v">{orderType === "market" ? `$${livePrice.toFixed(2)}` : limitPrice ? `$${limitPrice}` : "—"}</span></div>
            <div className="kv"><span className="k">Required margin</span><span className="v">{fmtUSD(collateral)}</span></div>
            <div className="kv"><span className="k">Liquidation price</span><span className="v" style={{ color: "#b4442a" }}>${liqPrice.toFixed(2)}</span></div>
            <div className="kv"><span className="k">Funding · 1h</span><span className="v">{(market.funding*100).toFixed(4)}%</span></div>
            <div className="kv"><span className="k">Drift fee</span><span className="v">{fmtUSD(notional * 0.0004)} · 4 bps</span></div>
            <div className="kv"><span className="k">Compute · CPI</span><span className="v">280,000 CU</span></div>
            <div className="kv kv-total"><span className="k">Tx cost · Rome</span><span className="v">$0.012</span></div>
          </div>

          <div style={{ padding: "16px 20px 20px" }}>
            <button className={`btn btn-xl ${side === "long" ? "btn-long" : "btn-short"}`} style={{ width: "100%" }} onClick={onSubmit}
              disabled={wallet.connected && !parseFloat(size)}>
              {!wallet.connected ? "Connect wallet" : !parseFloat(size) ? "Enter a size" :
                <>{side === "long" ? "Long" : "Short"} {size} {market.base} · {leverage}×</>}
            </button>
            <div className="row" style={{ justifyContent: "center", marginTop: 10, gap: 10 }}>
              <span className="badge badge-atomic">Atomic</span>
              <span className="tiny">One EVM signature · Drift CPI</span>
            </div>
          </div>
        </div>
      </div>

      <TxModal flow={flow} onClose={() => flow.reset()} onRetry={() => flow.run()}
        title={<><em>{side === "long" ? "Opening long" : "Opening short"}</em> {size} {market.base}</>}
        summary={`${leverage}× leverage · Drift · via Cardo Perps adapter 0x8CfC…C972`} />
    </main>
  );
};

const MiniStat = ({ k, v, big, color, mono }) => (
  <div>
    <div className="tiny" style={{ textTransform: "uppercase", letterSpacing: "0.12em" }}>{k}</div>
    <div className={mono || big ? "num" : ""} style={{ fontSize: big ? 26 : 15, marginTop: 2, color: color || "var(--fg1)", fontWeight: big ? 500 : 400, fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
      {v}
    </div>
  </div>
);

const ChartSVG = ({ candles }) => {
  const w = 1000, h = 340;
  const min = Math.min(...candles) * 0.995;
  const max = Math.max(...candles) * 1.005;
  const range = max - min;
  const pts = candles.map((c, i) => [(i / (candles.length - 1)) * w, h - ((c - min) / range) * h]);
  const line = pts.map((p, i) => (i === 0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`)).join(" ");
  const area = line + ` L${w},${h} L0,${h} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" width="100%" height="100%" style={{ display: "block" }}>
      <defs>
        <linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--rome-purple)" stopOpacity="0.15" />
          <stop offset="100%" stopColor="var(--rome-purple)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* grid */}
      {[0.25, 0.5, 0.75].map(g => (
        <line key={g} x1="0" x2={w} y1={h*g} y2={h*g} stroke="var(--border-subtle)" strokeDasharray="2 4" />
      ))}
      <path d={area} fill="url(#chart-fill)" />
      <path d={line} stroke="var(--rome-purple)" strokeWidth="1.8" fill="none" />
      {/* current price dot */}
      <circle cx={pts[pts.length-1][0]} cy={pts[pts.length-1][1]} r="4" fill="var(--rome-purple)" />
      <circle cx={pts[pts.length-1][0]} cy={pts[pts.length-1][1]} r="10" fill="var(--rome-purple)" opacity="0.2">
        <animate attributeName="r" values="4;14;4" dur="2.2s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.4;0;0.4" dur="2.2s" repeatCount="indefinite" />
      </circle>
    </svg>
  );
};

Object.assign(window, { Perps });
