/* global React, Roman, Eyebrow, Logomark, ProtocolChip, Sparkline, useLivePrice, fmtUSD, fmtPct, fmtNum */

const { useState, useEffect } = React;

// ---------------- Home / intent launcher ----------------
const Home = ({ onNav, wallet, heroVariant = "editorial" }) => {
  const solPrice = useLivePrice(149.22, 0.003);
  const btcPrice = useLivePrice(71_440, 0.002);
  const usdcApy = useLivePrice(8.24, 0.01);
  const funding = useLivePrice(0.0128, 0.02);

  const tiles = [
    {
      to: "/swap", roman: "I", title: "Swap", italic: "swap.",
      lede: "Any token, any amount. Routed through Meteora pools on Solana, settled in one EVM transaction.",
      protocols: ["meteora"],
      stat: { k: "USDC → SOL quote", v: "~6.693 SOL / $1,000" },
    },
    {
      to: "/lend", roman: "II", title: "Lend", italic: "lend.",
      lede: "Supply, borrow, repay against Kamino reserves. Health factor, LTV, rates — visible before you sign.",
      protocols: ["kamino"],
      stat: { k: "USDC supply APY", v: fmtPct(usdcApy) + " live" },
    },
    {
      to: "/perps", roman: "III", title: "Perps", italic: "trade.",
      lede: "Long or short Drift perps from any EVM wallet. Mark, funding, and liquidation price in the order form.",
      protocols: ["drift"],
      stat: { k: "SOL-PERP mark", v: "$" + solPrice.toFixed(2) },
    },
    {
      to: "/compose", roman: "IV", title: "Compose", italic: "orchestrate.",
      lede: "One intent, many protocols. Swap → deposit margin → open perp, in one signed transaction.",
      protocols: ["meteora","drift","kamino"],
      stat: { k: "Atomic", v: "Flagship · New" },
      flagship: true,
    },
  ];

  return (
    <main>
      {/* Hero */}
      <section style={{ position: "relative", overflow: "hidden" }}>
        <div className="hero-wash" />
        <div aria-hidden className="hero-watermark" style={{ width: 520, height: 520 }}>
          <svg viewBox="0 0 400 400" width="100%" height="100%" fill="none">
            <path d="M80 80 L200 200 L80 320 M320 80 L200 200 L320 320" stroke="var(--rome-purple)" strokeWidth="18" strokeLinecap="square" />
          </svg>
        </div>
        <div className="container" style={{ position: "relative", zIndex: 1, padding: "72px 32px 48px" }}>
          <Eyebrow>Cardo v1 · Rome chain · chainId 999999</Eyebrow>
          <h1 className="h1" style={{ marginTop: 22, maxWidth: 960 }}>
            Use Solana protocols from <em>any EVM wallet.</em><br />
            No bridging. No new accounts. One <em>transaction.</em>
          </h1>
          <p className="lede" style={{ marginTop: 24, maxWidth: 620 }}>
            Cardo is the dapp UI for every Solana protocol it integrates. Swap on Meteora, borrow on Kamino, trade perps on Drift — sign once from MetaMask, settle atomically on Solana.
          </p>
          <div className="row" style={{ gap: 10, marginTop: 32 }}>
            <button className="btn btn-primary btn-lg" onClick={() => onNav("/compose")}>
              Try Compose →
            </button>
            <button className="btn btn-ghost btn-lg" onClick={() => onNav("/swap")}>
              Open Swap
            </button>
            <span className="divider-v" />
            <a href="https://docs.rome.builders" className="small" style={{ color: "var(--fg2)", marginLeft: 8 }}>How it works ↗</a>
          </div>
        </div>
      </section>

      {/* Live ticker */}
      <div className="container" style={{ marginTop: 0 }}>
        <div className="ticker" style={{ borderRadius: 14, marginTop: 8 }}>
          <TickerCell label="SOL-PERP mark" value={"$" + solPrice.toFixed(2)} sub={<span className="delta-up">+1.24% · 24h</span>} />
          <TickerCell label="BTC-PERP mark" value={"$" + btcPrice.toLocaleString(undefined,{maximumFractionDigits:0})} sub={<span className="delta-down">−0.41% · 24h</span>} />
          <TickerCell label="USDC supply APY · Kamino" value={fmtPct(usdcApy)} sub="Utilization 72%" />
          <TickerCell label="SOL-PERP funding · 1h" value={fmtPct(funding, 4) + "%"} sub="Drift market 0" />
          <TickerCell label="Oracle freshness" value="Pyth · 0.8s" sub={<span className="delta-up">● live</span>} />
        </div>
      </div>

      {/* Action tiles */}
      <section className="container" style={{ marginTop: 72 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 20, marginBottom: 24 }}>
          <div>
            <Eyebrow>What you can do</Eyebrow>
            <h2 className="h2" style={{ marginTop: 6 }}>Four <em>actions</em>, one signature.</h2>
          </div>
          <p className="small" style={{ maxWidth: 380, margin: 0 }}>
            Every page ends in a signed EVM transaction that settles on Solana atomically. If any step fails, everything reverts.
          </p>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 20 }}>
          {tiles.map((t, i) => (
            <a key={t.to} href={"#" + t.to} className="card card-hover"
               onClick={(e) => { e.preventDefault(); onNav(t.to); }}
               style={{
                 padding: 26, display: "flex", flexDirection: "column", gap: 18,
                 minHeight: 300, textDecoration: "none", color: "inherit",
                 borderColor: t.flagship ? "rgba(94,10,96,0.28)" : "var(--border-subtle)",
                 background: t.flagship ? "linear-gradient(180deg, rgba(249,227,242,0.45) 0%, var(--bg-surface) 60%)" : "var(--bg-surface)",
               }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <Roman n={i+1} size={16} color="var(--fg2)" />
                {t.flagship && <span className="badge badge-atomic">Flagship</span>}
              </div>
              <div>
                <div className="h2" style={{ fontSize: 44, fontStyle: "italic", color: "var(--rome-purple)", lineHeight: 1 }}>{t.italic}</div>
                <div style={{ fontSize: 13, marginTop: 4, textTransform: "uppercase", letterSpacing: "0.14em", fontFamily: "var(--font-mono)", color: "var(--fg2)" }}>Cardo {t.title}</div>
              </div>
              <p style={{ fontSize: 14.5, color: "var(--fg1)", margin: 0, lineHeight: 1.5 }}>{t.lede}</p>
              <div className="row" style={{ gap: 6, flexWrap: "wrap", marginTop: "auto" }}>
                {t.protocols.map(p => <ProtocolChip key={p} p={p} />)}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", paddingTop: 16, borderTop: "1px solid var(--border-subtle)" }}>
                <span className="tiny" style={{ textTransform: "uppercase", letterSpacing: "0.12em" }}>{t.stat.k}</span>
                <span className="mono" style={{ fontSize: 13, color: "var(--fg1)" }}>{t.stat.v}</span>
              </div>
            </a>
          ))}
        </div>
      </section>

      {/* Trust row */}
      <section className="container" style={{ marginTop: 88, marginBottom: 96 }}>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", marginBottom: 18, flexWrap: "wrap", gap: 12 }}>
          <Eyebrow>Solana protocols bridged</Eyebrow>
          <span className="tiny" style={{ color: "var(--fg3)" }}>Source: github.com/rome-protocol/rome-showcase</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", border: "1px solid var(--border-subtle)", borderRadius: 14, overflow: "hidden", background: "var(--bg-surface)" }}>
          {[
            { name: "Meteora DAMM v1", sub: "USDC/WSOL pool · live", p: "meteora" },
            { name: "Kamino Lend", sub: "USDC + SOL reserves · live", p: "kamino" },
            { name: "Drift Protocol", sub: "SOL-PERP market · live", p: "drift" },
            { name: "Jupiter, Raydium", sub: "Q3 · route aggregation", p: "meteora", soon: true },
          ].map((p, i) => (
            <div key={p.name} style={{ padding: 22, borderLeft: i ? "1px solid var(--border-subtle)" : 0, opacity: p.soon ? 0.55 : 1 }}>
              <div className="row" style={{ gap: 8, marginBottom: 10 }}>
                <span className="protocol-dot" data-p={p.p} />
                <span className="mono" style={{ fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--fg2)" }}>
                  {p.soon ? "Soon" : "Live"}
                </span>
              </div>
              <div className="serif" style={{ fontSize: 20 }}>{p.name}</div>
              <div className="small" style={{ marginTop: 4 }}>{p.sub}</div>
            </div>
          ))}
        </div>

        <div className="row" style={{ marginTop: 32, flexWrap: "wrap", gap: 24, color: "var(--fg2)", fontSize: 13 }}>
          <span>Oracles: <span className="mono" style={{ color: "var(--fg1)" }}>Pyth</span> · <span className="mono" style={{ color: "var(--fg1)" }}>Switchboard V3</span></span>
          <span className="divider-v" />
          <span>Settlement chain: <span className="mono" style={{ color: "var(--fg1)" }}>Rome chain · 999999</span></span>
          <span className="divider-v" />
          <span>Audits: <a href="#" style={{ color: "var(--rome-purple)" }}>OtterSec · Zellic</a></span>
        </div>
      </section>
    </main>
  );
};

const TickerCell = ({ label, value, sub }) => (
  <div className="ticker-cell">
    <div>
      <div className="label">{label}</div>
      <div className="value" style={{ marginTop: 2 }}>{value}</div>
    </div>
    <span className="grow" />
    <div className="tiny">{sub}</div>
  </div>
);

Object.assign(window, { Home });
