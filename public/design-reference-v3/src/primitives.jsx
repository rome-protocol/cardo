/* global React */
// Shared primitives for Cardo

const { useState, useEffect, useRef, useMemo, useCallback } = React;

const ROMAN_NUMS = ["0","I","II","III","IV","V","VI","VII","VIII","IX","X","XI","XII"];
const Roman = ({ n, size = 16, color }) => (
  <span className="numeral" style={{ fontSize: size, color, fontFeatureSettings: '"onum"' }}>
    {ROMAN_NUMS[n] || n}.
  </span>
);

const Eyebrow = ({ children, style }) => <span className="eyebrow" style={style}>{children}</span>;

const Logomark = ({ size = 22, color = "currentColor" }) => (
  <svg width={size} height={size} viewBox="0 0 40 40" fill="none" aria-hidden="true">
    <path d="M8 8 L20 20 L8 32 M32 8 L20 20 L32 32" stroke={color} strokeWidth="3.2" strokeLinecap="square" strokeLinejoin="miter" />
  </svg>
);

// Token logos — minimal geometric SVGs; palette-aware placeholders.
const TokenLogo = ({ symbol, size = 28 }) => {
  const palette = {
    USDC: { bg: "#2775CA", fg: "#fff" },
    SOL:  { bg: "linear-gradient(135deg,#9945FF 0%,#14F195 100%)", fg: "#fff" },
    WSOL: { bg: "linear-gradient(135deg,#9945FF 0%,#14F195 100%)", fg: "#fff" },
    BTC:  { bg: "#F7931A", fg: "#fff" },
    ETH:  { bg: "#627EEA", fg: "#fff" },
    JUP:  { bg: "#2C2C2C", fg: "#fff" },
    JTO:  { bg: "#111", fg: "#fff" },
    BONK: { bg: "#FEAB35", fg: "#111" },
    mSOL: { bg: "#3DA69F", fg: "#fff" },
  };
  const p = palette[symbol] || { bg: "var(--rome-stone-100)", fg: "var(--fg1)" };
  const letter = symbol === "USDC" ? "$" : symbol.slice(0,1);
  return (
    <span style={{
      width: size, height: size, borderRadius: "50%",
      background: p.bg, color: p.fg,
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      fontFamily: "var(--font-sans)", fontWeight: 700, fontSize: size * 0.42,
      flexShrink: 0, letterSpacing: "-0.01em",
      boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.06)",
    }}>{letter}</span>
  );
};

// Protocol provenance (Meteora / Kamino / Drift)
const ProtocolChip = ({ p, size = "sm" }) => {
  const labels = { meteora: "Meteora", kamino: "Kamino", drift: "Drift", rome: "Rome" };
  return (
    <span className="protocol-chip" data-p={p} style={size === "lg" ? { fontSize: 12, padding: "6px 12px 6px 10px" } : null}>
      <span className="protocol-dot" data-p={p} style={{ margin: 0 }} />
      {labels[p] || p}
    </span>
  );
};

// Tiny sparkline
const Sparkline = ({ data = [], color = "var(--rome-purple)", w = 80, h = 22 }) => {
  if (!data.length) return null;
  const min = Math.min(...data), max = Math.max(...data);
  const range = max - min || 1;
  const pts = data.map((d,i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - ((d - min) / range) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return (
    <svg width={w} height={h} style={{ display: "block" }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
};

// Animated number (for live feel)
const useLivePrice = (initial, volatility = 0.002) => {
  const [v, setV] = useState(initial);
  useEffect(() => {
    const id = setInterval(() => {
      setV((prev) => {
        const drift = (Math.random() - 0.5) * 2 * volatility * prev;
        return +(prev + drift).toFixed(prev < 10 ? 4 : 2);
      });
    }, 2200);
    return () => clearInterval(id);
  }, [volatility]);
  return v;
};

// Format helpers
const fmtUSD = (n, opts = {}) => {
  const { compact = false, decimals = 2 } = opts;
  if (n == null || isNaN(n)) return "—";
  if (compact && Math.abs(n) >= 1e6) return `$${(n/1e6).toFixed(2)}M`;
  if (compact && Math.abs(n) >= 1e3) return `$${(n/1e3).toFixed(1)}K`;
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
};
const fmtPct = (n, decimals = 2) => `${n >= 0 ? "" : ""}${n.toFixed(decimals)}%`;
const fmtNum = (n, decimals = 4) => n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: decimals });
const shortAddr = (a) => a ? `${a.slice(0,6)}…${a.slice(-4)}` : "";

// ---- Nav ----
const Nav = ({ route, onNav, wallet, onConnect, onDisconnect, onOpenWallet }) => {
  const links = [
    { to: "/", label: "Home" },
    { to: "/swap", label: "Swap" },
    { to: "/lend", label: "Lend" },
    { to: "/perps", label: "Perps" },
    { to: "/compose", label: "Compose", badge: "Flagship" },
  ];
  const isActive = (to) => to === "/" ? route === "/" : route.startsWith(to);
  return (
    <header className="nav">
      <div className="nav-inner">
        <a className="nav-brand" href="#/" onClick={(e) => { e.preventDefault(); onNav("/"); }}>
          <Logomark size={20} color="var(--rome-purple)" />
          <span className="nav-brand-word">Cardo</span>
          <span className="nav-brand-tag">by Rome</span>
        </a>
        <nav className="nav-links">
          {links.map(l => (
            <a key={l.to} href={`#${l.to}`} className="nav-link"
               data-active={isActive(l.to) ? "true" : undefined}
               onClick={(e) => { e.preventDefault(); onNav(l.to); }}>
              {l.label}
              {l.badge && <span className="mono" style={{ marginLeft: 8, fontSize: 9, letterSpacing: "0.12em", color: "var(--rome-purple)", textTransform: "uppercase" }}>· {l.badge}</span>}
            </a>
          ))}
        </nav>
        <span className="nav-spacer" />
        <a href="#/for-agents" className="nav-link" data-active={route === "/for-agents" ? "true" : undefined}
           onClick={(e) => { e.preventDefault(); onNav("/for-agents"); }}
           style={{ fontSize: 13, color: "var(--fg2)" }}>For agents</a>
        {wallet.connected ? (
          <button type="button" className="wallet-chip" onClick={onOpenWallet}>
            <span className="wallet-dot" />
            <span className="addr">{shortAddr(wallet.address)}</span>
            <span className="bal">{fmtUSD(wallet.balanceUSD, { decimals: 0 })}</span>
          </button>
        ) : (
          <button type="button" className="wallet-btn" onClick={onConnect}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M3 7h16a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" stroke="currentColor" strokeWidth="1.6"/><path d="M3 7V5.5A1.5 1.5 0 014.5 4H17" stroke="currentColor" strokeWidth="1.6"/><circle cx="17" cy="13" r="1.3" fill="currentColor"/></svg>
            Connect wallet
          </button>
        )}
      </div>
      {route !== "/" && <NetworkBanner wallet={wallet} />}
    </header>
  );
};

const NetworkBanner = ({ wallet }) => {
  if (!wallet.connected || wallet.network === "<chain>") return null;
  return (
    <div style={{ background: "rgba(198,159,31,0.12)", borderBottom: "1px solid rgba(198,159,31,0.3)", padding: "10px 0", textAlign: "center", fontSize: 13 }}>
      You're on <strong>Ethereum</strong>. Cardo settles on Rome chain. <button className="btn btn-sm btn-ghost" style={{ marginLeft: 12 }}>Switch network</button>
    </div>
  );
};

// ---- Footer ----
const Footer = () => (
  <footer className="footer">
    <div className="footer-inner">
      <div>
        <div className="footer-brand">Cardo<span style={{ fontStyle: "normal" }}>.</span></div>
        <p style={{ marginTop: 12, opacity: 0.72, fontSize: 14, maxWidth: 320, lineHeight: 1.5 }}>
          Use Solana protocols from any EVM wallet. One transaction, atomic settlement.
        </p>
        <p className="mono" style={{ marginTop: 22, fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", opacity: 0.5 }}>
          Cardo · by Rome Protocol
        </p>
      </div>
      <div>
        <h5>Product</h5>
        <a href="#/swap">Swap</a>
        <a href="#/lend">Lend</a>
        <a href="#/perps">Perps</a>
        <a href="#/compose">Compose</a>
      </div>
      <div>
        <h5>Developers</h5>
        <a href="#/for-agents">For agents</a>
        <a href="https://docs.rome.builders">Docs</a>
        <a href="https://github.com/rome-protocol">Source</a>
      </div>
      <div>
        <h5>Rome</h5>
        <a href="https://rome.builders">rome.builders</a>
        <a href="#">Status</a>
        <a href="#">X / Twitter</a>
      </div>
    </div>
  </footer>
);

// Expose
Object.assign(window, {
  Roman, Eyebrow, Logomark, TokenLogo, ProtocolChip, Sparkline,
  useLivePrice, fmtUSD, fmtPct, fmtNum, shortAddr,
  Nav, Footer,
});
