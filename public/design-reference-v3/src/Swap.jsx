/* global React, Roman, Eyebrow, TokenLogo, ProtocolChip, useLivePrice, useTxFlow, TxModal, fmtUSD, fmtPct, fmtNum */

const { useState, useMemo, useEffect } = React;

const TOKENS = [
  { symbol: "USDC", name: "USD Coin", price: 1,       balance: 5420.18 },
  { symbol: "SOL",  name: "Solana",   price: 149.22,  balance: 3.214 },
  { symbol: "WSOL", name: "Wrapped SOL", price: 149.22, balance: 0 },
  { symbol: "BTC",  name: "Bitcoin",  price: 71440,   balance: 0.018 },
  { symbol: "ETH",  name: "Ethereum", price: 3412,    balance: 0.42 },
  { symbol: "JUP",  name: "Jupiter",  price: 0.72,    balance: 0 },
  { symbol: "BONK", name: "Bonk",     price: 0.000019, balance: 0 },
  { symbol: "mSOL", name: "Marinade SOL", price: 169.4, balance: 0 },
];

const Swap = ({ wallet, onConnect }) => {
  const [fromSym, setFromSym] = useState("USDC");
  const [toSym, setToSym] = useState("SOL");
  const [amount, setAmount] = useState("1000");
  const [slippage, setSlippage] = useState("0.5");
  const [showPicker, setShowPicker] = useState(null);
  const from = TOKENS.find(t => t.symbol === fromSym);
  const to = TOKENS.find(t => t.symbol === toSym);
  const solLive = useLivePrice(149.22, 0.002);
  const livePrice = toSym === "SOL" || toSym === "WSOL" ? solLive : to.price;

  const flow = useTxFlow();

  const a = parseFloat(amount) || 0;
  const rate = from.price / livePrice;
  const feeRate = 0.003; // 30 bps
  const out = a * rate * (1 - feeRate);
  const minOut = out * (1 - parseFloat(slippage)/100);
  const usdValue = a * from.price;
  const priceImpact = a > 50_000 ? (a / 1_000_000) * 100 : 0.08;

  const flip = () => { setFromSym(toSym); setToSym(fromSym); setAmount(out > 0 ? out.toFixed(6) : ""); };

  const canSubmit = wallet.connected && a > 0 && a <= from.balance;
  let btnLabel = "Swap";
  if (!wallet.connected) btnLabel = "Connect wallet";
  else if (a <= 0) btnLabel = "Enter an amount";
  else if (a > from.balance) btnLabel = `Insufficient ${fromSym}`;
  else if (fromSym !== "USDC" && fromSym !== "SOL" && fromSym !== "WSOL") btnLabel = `Approve ${fromSym} then swap`;

  const onSwap = () => {
    if (!wallet.connected) { onConnect(); return; }
    if (!canSubmit) return;
    flow.run();
  };

  return (
    <main className="container" style={{ padding: "40px 32px 96px" }}>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 340px", gap: 32, alignItems: "start" }}>
        {/* Left: swap card */}
        <div>
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 20 }}>
            <div>
              <Eyebrow>Cardo Swap · Meteora DAMM v1</Eyebrow>
              <h1 className="h2" style={{ marginTop: 6 }}>Swap any token, <em>atomically.</em></h1>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn btn-ghost btn-sm">Settings</button>
              <button className="btn btn-ghost btn-sm">History</button>
            </div>
          </div>

          <div className="card" style={{ padding: 0, overflow: "hidden" }}>
            {/* From */}
            <div style={{ padding: "22px 26px" }}>
              <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
                <span className="eyebrow">You pay</span>
                <span className="tiny">Balance: <span className="mono" style={{ color: "var(--fg1)" }}>{fmtNum(from.balance)}</span> {fromSym}</span>
              </div>
              <div className="row" style={{ gap: 16, alignItems: "flex-end" }}>
                <input className="amount-input" type="text" inputMode="decimal" placeholder="0.00"
                  value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} />
                <TokenButton sym={fromSym} onClick={() => setShowPicker("from")} />
              </div>
              <div className="row" style={{ justifyContent: "space-between", marginTop: 8 }}>
                <span className="tiny">≈ {fmtUSD(usdValue)}</span>
                <div className="row" style={{ gap: 6 }}>
                  {["25%","50%","MAX"].map(p => (
                    <button key={p} className="chip" onClick={() => {
                      const pct = p === "MAX" ? 1 : parseInt(p)/100;
                      setAmount((from.balance * pct).toFixed(6).replace(/\.?0+$/,""));
                    }}>{p}</button>
                  ))}
                </div>
              </div>
            </div>

            {/* Flip */}
            <div style={{ position: "relative", height: 0 }}>
              <button onClick={flip} className="step-arrow" style={{ position: "absolute", left: 26, top: -18, cursor: "pointer", background: "var(--bg-surface)", zIndex: 2, borderColor: "var(--border-default)" }}>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 6 L8 2 L12 6 M8 2 V10 M4 14 H12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
              </button>
            </div>

            {/* To */}
            <div style={{ padding: "22px 26px", background: "var(--rome-paper)", borderTop: "1px solid var(--border-subtle)" }}>
              <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
                <span className="eyebrow">You receive</span>
                <span className="tiny">Balance: <span className="mono" style={{ color: "var(--fg1)" }}>{fmtNum(to.balance)}</span> {toSym}</span>
              </div>
              <div className="row" style={{ gap: 16, alignItems: "flex-end" }}>
                <span className="amount-input" style={{ color: out > 0 ? "var(--fg1)" : "var(--fg3)" }}>
                  {out > 0 ? out.toFixed(6).replace(/\.?0+$/,"") : "0.00"}
                </span>
                <TokenButton sym={toSym} onClick={() => setShowPicker("to")} />
              </div>
              <div className="tiny" style={{ marginTop: 8 }}>≈ {fmtUSD(out * livePrice)}</div>
            </div>

            {/* Slippage */}
            <div style={{ padding: "18px 26px", borderTop: "1px solid var(--border-subtle)" }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span className="eyebrow">Slippage tolerance</span>
                <div className="row" style={{ gap: 6 }}>
                  {["0.1","0.5","1.0"].map(s => (
                    <button key={s} className="chip" data-active={slippage === s ? "true" : undefined} onClick={() => setSlippage(s)}>{s}%</button>
                  ))}
                  <input className="input" style={{ width: 72, padding: "4px 8px", fontFamily: "var(--font-mono)", fontSize: 12 }}
                    value={slippage} onChange={(e) => setSlippage(e.target.value)} />
                </div>
              </div>
            </div>

            {/* Cost panel */}
            <div style={{ padding: "18px 26px", borderTop: "1px solid var(--border-subtle)", background: "var(--bg-surface)" }}>
              <div className="kv"><span className="k">Rate</span><span className="v">1 {fromSym} = {fmtNum(rate, 6)} {toSym}</span></div>
              <div className="kv"><span className="k">Minimum received</span><span className="v">{fmtNum(minOut, 4)} {toSym}</span></div>
              <div className="kv"><span className="k">Pool fee <span className="mono tiny" style={{ marginLeft: 6 }}>30 bps</span></span><span className="v">{fmtUSD(usdValue * feeRate)}</span></div>
              <div className="kv"><span className="k">Solana rent · new ATA</span><span className="v">$0.020</span></div>
              <div className="kv"><span className="k">EVM gas · Rome</span><span className="v">$0.008</span></div>
              <div className="kv"><span className="k">Price impact</span><span className="v" style={{ color: priceImpact > 1 ? "#8a3320" : undefined }}>{fmtPct(priceImpact)}</span></div>
              <div className="kv kv-total"><span className="k">Total cost</span><span className="v">{fmtUSD(usdValue * feeRate + 0.028)}</span></div>
            </div>

            {/* Route */}
            <div style={{ padding: "14px 26px", borderTop: "1px solid var(--border-subtle)", background: "rgba(94,10,96,0.03)" }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <div className="row" style={{ gap: 10 }}>
                  <ProtocolChip p="meteora" />
                  <span className="small" style={{ color: "var(--fg1)" }}>
                    {fromSym} → {toSym} · DAMM v1 pool
                  </span>
                </div>
                <span className="tiny mono" style={{ color: "var(--fg2)" }}>CykB…PhCLa</span>
              </div>
            </div>

            {/* Execute */}
            <div style={{ padding: 22 }}>
              <button className="btn btn-primary btn-xl"
                onClick={onSwap}
                disabled={wallet.connected && !canSubmit}
                style={{ background: !wallet.connected || canSubmit ? "var(--rome-purple)" : "var(--rome-stone-100)" }}>
                {btnLabel}
              </button>
              <div className="row" style={{ marginTop: 12, justifyContent: "center", gap: 8 }}>
                <span className="badge badge-atomic">Atomic · one signature</span>
                <span className="tiny">Oracle: Pyth · 0.8s fresh</span>
              </div>
            </div>
          </div>
        </div>

        {/* Right: context panel */}
        <div>
          <div className="card" style={{ padding: 20, marginBottom: 16 }}>
            <Eyebrow>Your balances · Rome</Eyebrow>
            {wallet.connected ? (
              <div style={{ marginTop: 12 }}>
                {TOKENS.filter(t => t.balance > 0).map(t => (
                  <div key={t.symbol} className="row" style={{ padding: "10px 0", borderBottom: "1px solid var(--border-subtle)" }}>
                    <TokenLogo symbol={t.symbol} size={28} />
                    <div style={{ marginLeft: 10, flex: 1 }}>
                      <div style={{ fontSize: 14 }}>{t.symbol}</div>
                      <div className="tiny">{t.name}</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div className="mono" style={{ fontSize: 13 }}>{fmtNum(t.balance)}</div>
                      <div className="tiny">{fmtUSD(t.balance * t.price, { decimals: t.price > 100 ? 0 : 2 })}</div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ marginTop: 14 }}>
                <p className="small" style={{ margin: 0 }}>Connect a wallet to see balances and quote with your position.</p>
                <button className="btn btn-ink btn-sm" style={{ marginTop: 12 }} onClick={onConnect}>Connect wallet</button>
              </div>
            )}
          </div>

          <div className="card" style={{ padding: 20 }}>
            <Eyebrow>Recent swaps</Eyebrow>
            <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 12 }}>
              {[
                { from: "USDC", to: "SOL", amt: "500.00", out: "3.348", t: "2m ago", ok: true },
                { from: "SOL", to: "USDC", amt: "1.200", out: "178.61", t: "1h ago", ok: true },
                { from: "USDC", to: "BONK", amt: "200.00", out: "—", t: "yesterday", ok: false },
              ].map((r,i) => (
                <div key={i} className="row" style={{ gap: 10, fontSize: 13 }}>
                  <span className="status-pill" data-status={r.ok ? "live" : "failed"} style={{ padding: "3px 8px", fontSize: 9 }}>
                    <span className="dot" />
                    {r.ok ? "OK" : "Failed"}
                  </span>
                  <span className="mono" style={{ fontSize: 12 }}>{r.amt} {r.from} → {r.out} {r.to}</span>
                  <span className="grow" />
                  <span className="tiny">{r.t}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="card" style={{ padding: 20, marginTop: 16, background: "var(--rome-paper)", borderColor: "transparent" }}>
            <div className="row" style={{ gap: 10, marginBottom: 8 }}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1 L15 4.5 V11 L8 14.5 L1 11 V4.5 Z" stroke="var(--rome-purple)" strokeWidth="1.2"/></svg>
              <Eyebrow style={{ color: "var(--rome-purple)" }}>Under the hood</Eyebrow>
            </div>
            <p className="small" style={{ margin: 0, fontSize: 12.5 }}>
              Cardo calls <span className="mono" style={{ fontSize: 11, background: "rgba(255,255,255,0.6)", padding: "1px 5px", borderRadius: 4 }}>RomeCross.swapAToB</span> on Rome, which CPIs into the Meteora DAMM v1 program on Solana. Settles in one atomic Rome tx. You sign once in MetaMask.
            </p>
          </div>
        </div>
      </div>

      {showPicker && <TokenPicker current={showPicker === "from" ? fromSym : toSym}
        onPick={(s) => { showPicker === "from" ? setFromSym(s) : setToSym(s); setShowPicker(null); }}
        onClose={() => setShowPicker(null)} />}

      <TxModal flow={flow} onClose={flow.reset} onRetry={() => flow.run()}
        title={<><em>Swapping</em> {amount} {fromSym} → {out.toFixed(4)} {toSym}</>}
        summary={`Via Meteora DAMM v1 · min ${minOut.toFixed(4)} ${toSym} at ${slippage}% slippage`} />
    </main>
  );
};

const TokenButton = ({ sym, onClick }) => (
  <button type="button" className="card card-hover" onClick={onClick}
    style={{ padding: "8px 14px 8px 8px", display: "flex", alignItems: "center", gap: 10, borderRadius: 999, border: "1px solid var(--border-default)", background: "var(--bg-surface)", cursor: "pointer" }}>
    <TokenLogo symbol={sym} size={28} />
    <span style={{ fontSize: 16, fontWeight: 600 }}>{sym}</span>
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M4 6 L8 10 L12 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
  </button>
);

const TokenPicker = ({ current, onPick, onClose }) => {
  const [q, setQ] = useState("");
  const filtered = TOKENS.filter(t =>
    t.symbol.toLowerCase().includes(q.toLowerCase()) || t.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440 }}>
        <Eyebrow>Select token</Eyebrow>
        <input className="input" autoFocus placeholder="Search name or paste address" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginTop: 14 }} />
        <div style={{ maxHeight: 380, overflow: "auto", marginTop: 14, marginRight: -8, paddingRight: 4 }}>
          {filtered.map(t => (
            <button key={t.symbol} type="button" onClick={() => onPick(t.symbol)} disabled={t.symbol === current}
              style={{ width: "100%", display: "flex", alignItems: "center", gap: 12, padding: "10px 8px", border: 0, background: "transparent", borderRadius: 10, cursor: "pointer", opacity: t.symbol === current ? 0.4 : 1, textAlign: "left" }}
              onMouseEnter={e => e.currentTarget.style.background = "var(--rome-paper)"}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <TokenLogo symbol={t.symbol} size={32} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{t.symbol}</div>
                <div className="tiny">{t.name}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div className="mono" style={{ fontSize: 13 }}>{fmtNum(t.balance)}</div>
                <div className="tiny">{fmtUSD(t.balance * t.price)}</div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

Object.assign(window, { Swap });
