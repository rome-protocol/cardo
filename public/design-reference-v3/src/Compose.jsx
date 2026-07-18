/* global React, Roman, Eyebrow, TokenLogo, ProtocolChip, useTxFlow, TxModal, fmtUSD, fmtPct, fmtNum */

const { useState, useEffect, useMemo } = React;

// Recipe presets
const RECIPES = [
  {
    id: "perp-with-usdc",
    title: "Open a SOL perp with USDC",
    desc: "Swap USDC → SOL-margin collateral, deposit to Drift, open SOL-PERP position.",
    steps: 3,
    protocols: ["meteora", "drift"],
  },
  {
    id: "lev-loop",
    title: "Leveraged SOL lending loop",
    desc: "Deposit SOL to Kamino, borrow USDC, swap back to SOL, redeposit. 2× exposure.",
    steps: 4,
    protocols: ["kamino", "meteora"],
  },
  {
    id: "yield-carry",
    title: "USDC → mSOL → supply",
    desc: "Swap stable for mSOL (staking yield), supply on Kamino for compounding rate.",
    steps: 2,
    protocols: ["meteora", "kamino"],
  },
];

const Compose = ({ wallet, onConnect, pathStyle = "horizontal" }) => {
  const [amount, setAmount] = useState("1000");
  const [intent, setIntent] = useState("Open a SOL perp with $1000 USDC");
  const [selected, setSelected] = useState(RECIPES[0]);
  const [expanded, setExpanded] = useState(null);
  const flow = useTxFlow();

  // Given the selected recipe, build the execution path
  const path = useMemo(() => {
    if (selected.id === "perp-with-usdc") {
      const a = parseFloat(amount) || 0;
      const sol = a / 149.22;
      return [
        { id: "swap", protocol: "meteora", label: "Swap USDC → SOL", runtime: "SOL",
          detail: `${fmtNum(a,2)} USDC → ${fmtNum(sol, 4)} SOL`, cu: 600000, bps: 30,
          contract: "RomeCross · 0x0Ff3…b565", program: "Meteora DAMM v1" },
        { id: "deposit", protocol: "drift", label: "Deposit margin", runtime: "SOL",
          detail: `${fmtNum(sol, 4)} SOL → Drift User account`, cu: 140000, bps: 0,
          contract: "DriftPerps · 0x8CfC…C972", program: "drift_v2" },
        { id: "perp", protocol: "drift", label: "Open SOL-PERP · long", runtime: "SOL",
          detail: `${fmtNum(sol * 5, 4)} SOL · 5× leverage · liq $118.40`, cu: 280000, bps: 4,
          contract: "DriftPerps · 0x8CfC…C972", program: "drift_v2" },
      ];
    }
    if (selected.id === "lev-loop") {
      const a = parseFloat(amount) || 0;
      return [
        { id: "dep", protocol: "kamino", label: "Deposit SOL", runtime: "SOL", detail: `${fmtNum(a/149.22,4)} SOL collateral`, cu: 180000, bps: 0, contract: "KaminoLend · 0x55C5…77bd", program: "kamino_lend" },
        { id: "brw", protocol: "kamino", label: "Borrow USDC", runtime: "SOL", detail: `${fmtNum(a*0.65, 2)} USDC @ 11.4% APY`, cu: 200000, bps: 0, contract: "KaminoLend · 0x55C5…77bd", program: "kamino_lend" },
        { id: "swp", protocol: "meteora", label: "Swap USDC → SOL", runtime: "SOL", detail: `${fmtNum(a*0.65, 2)} USDC → ${fmtNum(a*0.65/149.22, 4)} SOL`, cu: 600000, bps: 30, contract: "RomeCross · 0x0Ff3…b565", program: "Meteora DAMM v1" },
        { id: "dep2", protocol: "kamino", label: "Redeposit SOL", runtime: "SOL", detail: `${fmtNum(a*0.65/149.22,4)} SOL → reserve`, cu: 180000, bps: 0, contract: "KaminoLend · 0x55C5…77bd", program: "kamino_lend" },
      ];
    }
    const a = parseFloat(amount) || 0;
    return [
      { id: "swp", protocol: "meteora", label: "Swap USDC → mSOL", runtime: "SOL", detail: `${fmtNum(a,2)} USDC → ${fmtNum(a/169.4, 4)} mSOL`, cu: 620000, bps: 30, contract: "RomeCross · 0x0Ff3…b565", program: "Meteora DAMM v1" },
      { id: "dep", protocol: "kamino", label: "Supply mSOL", runtime: "SOL", detail: `${fmtNum(a/169.4, 4)} mSOL → Kamino reserve`, cu: 180000, bps: 0, contract: "KaminoLend · 0x55C5…77bd", program: "kamino_lend" },
    ];
  }, [selected, amount]);

  const totalCu = path.reduce((s, p) => s + p.cu, 0);
  const totalFeeBps = path.reduce((s, p) => s + p.bps, 0);
  const a = parseFloat(amount) || 0;
  const totalFeeUsd = a * (totalFeeBps / 10000);

  const onExec = () => {
    if (!wallet.connected) return onConnect();
    flow.run();
  };

  return (
    <main className="container" style={{ padding: "36px 32px 96px", maxWidth: 1280 }}>
      {/* Hero */}
      <div style={{ marginBottom: 36 }}>
        <div className="row" style={{ gap: 12, marginBottom: 8 }}>
          <Eyebrow>Cardo Compose · Flagship</Eyebrow>
          <span className="badge badge-atomic">Atomic multi-protocol</span>
        </div>
        <h1 className="h1" style={{ margin: 0, fontSize: "clamp(36px, 4.4vw, 56px)" }}>
          One intent. <em>Many</em> protocols.<br />
          One <em>signature.</em>
        </h1>
        <p className="lede" style={{ maxWidth: 640, marginTop: 16 }}>
          Express what you want in plain terms. Cardo resolves the path across Meteora, Kamino, and Drift — then settles everything in a single Rome transaction, atomic across both runtimes.
        </p>
      </div>

      {/* Intent input */}
      <div className="card" style={{ padding: 26, background: "linear-gradient(135deg, rgba(249,227,242,0.4) 0%, rgba(219,239,247,0.3) 100%)", border: "1px solid rgba(94,10,96,0.14)" }}>
        <Eyebrow>Your intent</Eyebrow>
        <textarea
          value={intent}
          onChange={(e) => setIntent(e.target.value)}
          className="intent-textarea"
          placeholder='Describe what you want to do. E.g. "Swap $500 to SOL and supply it to Kamino."'
          rows={2}
        />
        <div className="row" style={{ gap: 8, flexWrap: "wrap", marginTop: 14 }}>
          <span className="tiny" style={{ alignSelf: "center", marginRight: 4 }}>Try:</span>
          {RECIPES.map(r => (
            <button key={r.id} type="button" className="chip"
              data-active={selected.id === r.id ? "true" : undefined}
              onClick={() => { setSelected(r); setIntent(r.title); }}>
              {r.title}
            </button>
          ))}
        </div>
      </div>

      {/* Path preview */}
      <div style={{ marginTop: 32 }}>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-end", marginBottom: 18 }}>
          <div>
            <Eyebrow>Execution path</Eyebrow>
            <h2 className="h3" style={{ margin: "4px 0 0", fontFamily: "var(--font-serif)", fontSize: 26, fontWeight: 400 }}>
              <Roman n={0} size={22} /> → {path.length} {path.length === 1 ? "step" : "steps"} across {new Set(path.map(p => p.protocol)).size} protocols
            </h2>
          </div>
          <div className="row" style={{ gap: 8, alignItems: "center" }}>
            <div className="row" style={{ gap: 6 }}>
              <label className="tiny">Amount</label>
              <div className="input-group" style={{ width: 140, background: "var(--bg-surface)" }}>
                <span className="input-prefix">$</span>
                <input className="amount-input-sm" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} />
              </div>
            </div>
          </div>
        </div>

        {pathStyle === "horizontal" ? (
          <HorizontalPath path={path} expanded={expanded} setExpanded={setExpanded} />
        ) : (
          <VerticalPath path={path} expanded={expanded} setExpanded={setExpanded} />
        )}

        {/* Totals */}
        <div className="card" style={{ marginTop: 20, padding: "20px 26px" }}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start", gap: 24, flexWrap: "wrap" }}>
            <div style={{ minWidth: 220 }}>
              <Eyebrow>Estimated outcome</Eyebrow>
              <div className="serif" style={{ fontSize: 30, marginTop: 6, letterSpacing: "-0.01em" }}>
                {selected.id === "perp-with-usdc" ? <><em>~{fmtNum(a/149.22 * 5, 3)} SOL</em> · 5× long</> :
                 selected.id === "lev-loop" ? <><em>~{fmtNum(a/149.22 * 1.65, 3)} SOL</em> · 2× exposure</> :
                 <><em>~{fmtNum(a/169.4, 4)} mSOL</em> · supplied</>}
              </div>
            </div>
            <div className="divider-v" style={{ alignSelf: "stretch" }} />
            <Stat k="Total steps" v={`${path.length}`} serif />
            <Stat k="Protocol fees" v={`${totalFeeBps} bps · ${fmtUSD(totalFeeUsd)}`} />
            <Stat k="Solana compute" v={`${totalCu.toLocaleString()} CU`} />
            <Stat k="EVM gas · Rome" v="$0.018" />
            <Stat k="Latency" v="~1.2s" />
          </div>
          <div style={{ marginTop: 20, paddingTop: 20, borderTop: "1px solid var(--border-subtle)" }}>
            <div className="row" style={{ gap: 14, alignItems: "center", flexWrap: "wrap" }}>
              <button className="btn btn-primary btn-xl" onClick={onExec} style={{ minWidth: 280 }}>
                {!wallet.connected ? "Connect wallet to simulate" : `Sign ${path.length}-step intent`}
              </button>
              <div className="row" style={{ gap: 8 }}>
                <span className="badge badge-atomic">All-or-nothing · one signature</span>
              </div>
              <span className="grow" />
              <button className="btn btn-ghost btn-sm">View simulated trace →</button>
            </div>
            <p className="small" style={{ marginTop: 12, color: "var(--fg2)", margin: "12px 0 0", fontSize: 12.5 }}>
              If any step fails — slippage, reserve cap, position limit — the entire transaction reverts. Your USDC stays where it is.
            </p>
          </div>
        </div>
      </div>

      <TxModal flow={flow} onClose={() => flow.reset()} onRetry={() => flow.run()}
        title={<><em>Composing</em> {path.length}-step intent</>}
        summary={`${intent.slice(0, 64)}${intent.length > 64 ? "…" : ""}`}
        steps={["signing", "submitting", "confirming", "confirmed"]} />
    </main>
  );
};

const Stat = ({ k, v, serif }) => (
  <div>
    <div className="tiny" style={{ textTransform: "uppercase", letterSpacing: "0.1em" }}>{k}</div>
    <div className={serif ? "numeral" : "mono num"} style={{ fontSize: serif ? 22 : 15, marginTop: 3 }}>{v}</div>
  </div>
);

const protocolLabels = { meteora: "Meteora", kamino: "Kamino", drift: "Drift" };

const HorizontalPath = ({ path, expanded, setExpanded }) => (
  <div className="path-h" style={{ display: "flex", alignItems: "stretch", gap: 0, overflowX: "auto", padding: "12px 2px" }}>
    {path.map((step, i) => (
      <React.Fragment key={step.id}>
        <StepCard step={step} i={i} expanded={expanded === step.id} onToggle={() => setExpanded(expanded === step.id ? null : step.id)} />
        {i < path.length - 1 && <PathArrow />}
      </React.Fragment>
    ))}
  </div>
);

const StepCard = ({ step, i, expanded, onToggle }) => (
  <div className="step-card" data-expanded={expanded ? "true" : undefined} onClick={onToggle}>
    <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
      <Roman n={i + 1} size={14} color="var(--fg3)" />
      <ProtocolChip p={step.protocol} />
    </div>
    <div style={{ fontFamily: "var(--font-serif)", fontSize: 18, fontWeight: 500, marginBottom: 4 }}>{step.label}</div>
    <div className="small" style={{ color: "var(--fg2)", marginBottom: 12 }}>{step.detail}</div>
    <div className="tiny mono" style={{ textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--fg3)" }}>
      <span className="runtime-chip" data-rt={step.runtime}>
        {step.runtime === "SOL" ? "Settles · Solana" : "Settles · EVM"}
      </span>
    </div>
    {expanded && (
      <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px dashed var(--border-subtle)", fontSize: 12 }}>
        <div className="kv" style={{ padding: "3px 0" }}><span className="k" style={{ fontSize: 11 }}>Contract</span><span className="v mono" style={{ fontSize: 11 }}>{step.contract}</span></div>
        <div className="kv" style={{ padding: "3px 0" }}><span className="k" style={{ fontSize: 11 }}>Program</span><span className="v mono" style={{ fontSize: 11 }}>{step.program}</span></div>
        <div className="kv" style={{ padding: "3px 0" }}><span className="k" style={{ fontSize: 11 }}>CU</span><span className="v mono" style={{ fontSize: 11 }}>{step.cu.toLocaleString()}</span></div>
        <div className="kv" style={{ padding: "3px 0" }}><span className="k" style={{ fontSize: 11 }}>Fee</span><span className="v mono" style={{ fontSize: 11 }}>{step.bps} bps</span></div>
      </div>
    )}
  </div>
);

const PathArrow = () => (
  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "0 10px", minWidth: 40, color: "var(--rome-purple)" }}>
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M4 12h14m-5-5l5 5-5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  </div>
);

const VerticalPath = ({ path, expanded, setExpanded }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
    {path.map((step, i) => (
      <div key={step.id} className="card" style={{ padding: "18px 22px", cursor: "pointer" }} onClick={() => setExpanded(expanded === step.id ? null : step.id)}>
        <div className="row" style={{ gap: 18 }}>
          <div style={{ width: 34, height: 34, borderRadius: "50%", background: "var(--rome-paper)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <Roman n={i + 1} size={14} />
          </div>
          <div style={{ flex: 1 }}>
            <div className="row" style={{ gap: 10, marginBottom: 2 }}>
              <span style={{ fontFamily: "var(--font-serif)", fontSize: 18 }}>{step.label}</span>
              <ProtocolChip p={step.protocol} />
            </div>
            <div className="small" style={{ color: "var(--fg2)" }}>{step.detail}</div>
          </div>
          <span className="tiny mono">{step.cu.toLocaleString()} CU</span>
        </div>
      </div>
    ))}
  </div>
);

Object.assign(window, { Compose });
