'use client';
// Ported from designer's V3 delivery (src/TxReceipt.jsx). Visual layer is
// byte-preserved; only module-system seams adapted.

import React, { useState } from 'react';
import { Eyebrow, fmtUSD } from '../primitives';
import { TxHash } from '../design/Inline';
import { useActiveChainId } from '@/lib/env-context';

// Mock receipt
const RECEIPT = {
  hash: "0x9e4f2b8c1d7a5e6f3b9c8d2e4a1f6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a",
  status: "confirmed",
  block: 4991208,
  ts: "2026-04-23 14:32:08 UTC",
  from: "0x8A3f…2b19",
  to: "0x8CfCF5ffabd4f6Ff89F351e1ed3Bf38d45B0C972",
  toName: "Cardo Perps (DriftPerpsAdapter)",
  fn: "placePerpOrder",
  args: { marketIndex: 0, direction: "long", baseAssetAmount: "1000000000", price: "0" },
  gasEvm: 412_081,
  cuSolana: 284_219,
  feeUsd: 0.012,
  value: 149.22 * 1,
  summary: "Opened 1.0 SOL-PERP long at $149.22 · 5× leverage",
  trace: [
    { type: "evm", depth: 0, label: "placePerpOrder", target: "DriftPerpsAdapter", color: "purple", gas: 412081 },
    {   type: "evm", depth: 1, label: "CostEstimator.quoteCost", target: "CostEstimator", color: "gray", gas: 18022 },
    {   type: "cpi", depth: 1, label: "CPI → drift_v2.placePerpOrder", target: "drift_v2", color: "solana", cu: 284219 },
    {     type: "sol", depth: 2, label: "load User account", target: "drift_v2::User", color: "solana", cu: 12_400 },
    {     type: "sol", depth: 2, label: "load PerpMarket (idx 0)", target: "drift_v2::PerpMarket", color: "solana", cu: 18_800 },
    {     type: "sol", depth: 2, label: "oracle_price()", target: "pyth::sol_usd", color: "solana", cu: 21_200 },
    {     type: "sol", depth: 2, label: "place_perp_order", target: "drift_v2::place_perp_order", color: "solana", cu: 201_819 },
    {       type: "log", depth: 3, label: "emit OrderRecord{id: 1842, size: 1e9, dir: long}", target: null, color: "log" },
    {     type: "sol", depth: 2, label: "fill_order (maker)", target: "drift_v2::fill_perp_order", color: "solana", cu: 30_000 },
    {   type: "evm", depth: 1, label: "return orderRef = 0x0001…1842", target: "", color: "gray", gas: 800 },
  ],
  logs: [
    { addr: "0x8CfC…C972", topic0: "OrderPlaced(bytes32,uint16,uint8,uint256)", data: "orderRef=0x01c2, marketIndex=0, direction=long, baseAssetAmount=1e9" },
    { addr: "0x8CfC…C972", topic0: "AtomicBridgeSettled(bytes32,uint256)", data: "ref=0x01c2, cu=284219" },
  ],
};

const TxReceipt = ({ onNav }) => {
  const [tab, setTab] = useState("trace");
  const chainId = useActiveChainId();
  return (
    <main className="container" style={{ padding: "32px 32px 96px", maxWidth: 1100 }}>
      {/* Crumb */}
      <div className="row" style={{ fontSize: 13, color: "var(--fg2)", marginBottom: 14 }}>
        <a href="#/" onClick={(e) => { e.preventDefault(); onNav("/"); }} style={{ color: "var(--rome-purple)" }}>Home</a>
        <span style={{ margin: "0 8px", color: "var(--fg3)" }}>/</span>
        <span className="mono" style={{ fontSize: 12 }}>tx / {RECEIPT.hash.slice(0,10)}…</span>
      </div>

      {/* Header card */}
      <div className="card" style={{ padding: 28, marginBottom: 20, background: "linear-gradient(170deg, rgba(26,142,74,0.06) 0%, var(--bg-surface) 60%)", borderColor: "rgba(26,142,74,0.25)" }}>
        <div className="row" style={{ alignItems: "flex-start", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
          <div>
            <div className="row" style={{ gap: 10, marginBottom: 6 }}>
              <span className="status-pill" data-status="live" style={{ background: "rgba(26,142,74,0.12)", color: "#1a8e4a", borderColor: "rgba(26,142,74,0.3)" }}>
                <svg width="10" height="10" viewBox="0 0 16 16"><path d="M3 8.5 L6.5 12 L13 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none"/></svg>
                Confirmed
              </span>
              <Eyebrow>Atomic · Cross-runtime</Eyebrow>
            </div>
            <h1 className="serif" style={{ margin: 0, fontSize: 32, fontWeight: 500, letterSpacing: "-0.01em" }}>
              {RECEIPT.summary.split('·')[0]} <em>· {RECEIPT.summary.split('·')[1]}</em>
            </h1>
            <div className="row" style={{ gap: 20, marginTop: 14, flexWrap: "wrap" }}>
              <KV k="Block" v={RECEIPT.block.toLocaleString()} />
              <KV k="Confirmed" v={RECEIPT.ts} />
              <KV k="Fee" v={fmtUSD(RECEIPT.feeUsd)} />
              <KV k="EVM gas" v={RECEIPT.gasEvm.toLocaleString()} />
              <KV k="Solana CU" v={RECEIPT.cuSolana.toLocaleString()} />
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div className="tiny mono" style={{ textTransform: "uppercase", letterSpacing: "0.1em" }}>Hash</div>
            <div style={{ marginTop: 4 }}><TxHash hash={RECEIPT.hash} /></div>
          </div>
        </div>

        {/* Runtime split */}
        <div style={{ marginTop: 24, padding: 18, borderRadius: 12, background: "var(--bg-surface)", border: "1px solid var(--border-subtle)" }}>
          <Eyebrow>Runtime breakdown</Eyebrow>
          <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", alignItems: "center", gap: 20, marginTop: 14 }}>
            <RuntimeCard side="EVM" subtitle={`Rome chain · chainId ${chainId}`} items={[
              { k: "Caller", v: RECEIPT.from, mono: true },
              { k: "Contract", v: RECEIPT.toName },
              { k: "Function", v: RECEIPT.fn + "()" , mono: true },
              { k: "Gas", v: RECEIPT.gasEvm.toLocaleString() },
            ]} />
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "0 4px" }}>
              <div className="mono" style={{ fontSize: 10, letterSpacing: "0.1em", color: "var(--fg3)", textTransform: "uppercase", marginBottom: 8 }}>CPI</div>
              <svg width="60" height="40" viewBox="0 0 60 40"><path d="M0 20h50m-8-8l8 8-8 8" stroke="var(--rome-purple)" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
              <div className="tiny" style={{ marginTop: 6 }}>atomic</div>
            </div>
            <RuntimeCard side="Solana" subtitle="Mainnet · 2 programs" items={[
              { k: "Program", v: "drift_v2", mono: true },
              { k: "Oracle", v: "pyth::sol_usd" },
              { k: "CU", v: RECEIPT.cuSolana.toLocaleString() },
              { k: "Slot", v: "301,842,991" },
            ]} />
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ padding: "0 22px", borderBottom: "1px solid var(--border-subtle)" }}>
          <div className="row" style={{ gap: 0 }}>
            {[
              { k: "trace", label: "CPI trace" },
              { k: "logs", label: "Events" },
              { k: "abi", label: "Decoded input" },
              { k: "raw", label: "Raw tx" },
            ].map(t => (
              <button key={t.k} type="button" onClick={() => setTab(t.k)}
                style={{ padding: "14px 4px", marginRight: 28, fontSize: 13, fontWeight: tab === t.k ? 600 : 400,
                  color: tab === t.k ? "var(--rome-purple)" : "var(--fg2)", background: "transparent", border: 0,
                  borderBottom: "2px solid " + (tab === t.k ? "var(--rome-purple)" : "transparent"), cursor: "pointer" }}>
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <div style={{ padding: "22px 26px" }}>
          {tab === "trace" && <CpiTrace trace={RECEIPT.trace} />}
          {tab === "logs" && <Logs logs={RECEIPT.logs} />}
          {tab === "abi" && <DecodedInput fn={RECEIPT.fn} args={RECEIPT.args} />}
          {tab === "raw" && <RawTx />}
        </div>
      </div>
    </main>
  );
};

const KV = ({ k, v }) => (
  <div>
    <div className="tiny" style={{ textTransform: "uppercase", letterSpacing: "0.1em" }}>{k}</div>
    <div className="mono num" style={{ fontSize: 13, marginTop: 2 }}>{v}</div>
  </div>
);

const RuntimeCard = ({ side, subtitle, items }) => (
  <div style={{ padding: 16, borderRadius: 10, background: "var(--rome-paper)", border: "1px solid var(--border-subtle)" }}>
    <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
      <div style={{ fontFamily: "var(--font-serif)", fontSize: 18 }}>{side}</div>
      <span className="tiny mono">{subtitle}</span>
    </div>
    {items.map((it, i) => (
      <div key={i} className="row" style={{ justifyContent: "space-between", padding: "4px 0", fontSize: 12.5 }}>
        <span style={{ color: "var(--fg2)" }}>{it.k}</span>
        <span className={it.mono ? "mono" : ""} style={{ fontSize: it.mono ? 12 : 13, fontWeight: 500 }}>{it.v}</span>
      </div>
    ))}
  </div>
);

const CpiTrace = ({ trace }) => (
  <div style={{ fontFamily: "var(--font-mono)", fontSize: 13 }}>
    {trace.map((t, i) => {
      const colors = {
        purple: { bg: "rgba(94,10,96,0.06)", bd: "rgba(94,10,96,0.25)", dot: "var(--rome-purple)" },
        solana: { bg: "rgba(20,241,149,0.06)", bd: "rgba(20,241,149,0.25)", dot: "#14F195" },
        gray: { bg: "transparent", bd: "var(--border-subtle)", dot: "var(--fg3)" },
        log: { bg: "rgba(198,159,31,0.05)", bd: "rgba(198,159,31,0.2)", dot: "#c69f1f" },
      };
      const c = colors[t.color] || colors.gray;
      return (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 10px", marginLeft: t.depth * 22, borderLeft: `2px solid ${c.bd}`, background: c.bg, borderRadius: t.type === "log" ? 4 : 0, marginBottom: 1 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: c.dot, flexShrink: 0 }} />
          <span className="mono" style={{ fontSize: 10, color: "var(--fg3)", textTransform: "uppercase", minWidth: 30 }}>{t.type}</span>
          <span style={{ color: t.type === "log" ? "#8a6a10" : "var(--fg1)" }}>{t.label}</span>
          {t.target && <span style={{ color: "var(--fg3)", marginLeft: "auto", fontSize: 12 }}>{t.target}</span>}
          {t.gas != null && <span className="tiny" style={{ marginLeft: 12, color: "var(--fg3)" }}>{t.gas.toLocaleString()} gas</span>}
          {t.cu != null && <span className="tiny" style={{ marginLeft: 12, color: "#1a8e4a" }}>{t.cu.toLocaleString()} CU</span>}
        </div>
      );
    })}
  </div>
);

const Logs = ({ logs }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
    {logs.map((l, i) => (
      <div key={i} className="card" style={{ padding: 14, background: "var(--rome-paper)" }}>
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
          <span className="mono" style={{ fontSize: 11, color: "var(--fg3)" }}>{l.addr}</span>
          <span className="tiny">Log #{i}</span>
        </div>
        <div className="mono" style={{ fontSize: 12, color: "var(--rome-purple)", marginBottom: 4 }}>{l.topic0}</div>
        <div className="mono" style={{ fontSize: 12, color: "var(--fg2)" }}>{l.data}</div>
      </div>
    ))}
  </div>
);

const DecodedInput = ({ fn, args }) => (
  <div>
    <div className="mono" style={{ fontSize: 13, color: "var(--rome-purple)", marginBottom: 14 }}>
      {fn}(<span style={{ color: "var(--fg2)" }}>{Object.keys(args).join(", ")}</span>)
    </div>
    <table className="tbl-inner">
      <thead><tr><th>Name</th><th>Type</th><th>Value</th></tr></thead>
      <tbody>
        <tr><td className="mono">marketIndex</td><td className="mono" style={{ color: "var(--fg3)" }}>uint16</td><td className="mono">{args.marketIndex} <span className="tiny">· SOL-PERP</span></td></tr>
        <tr><td className="mono">direction</td><td className="mono" style={{ color: "var(--fg3)" }}>uint8</td><td className="mono">0 <span className="tiny">· long</span></td></tr>
        <tr><td className="mono">baseAssetAmount</td><td className="mono" style={{ color: "var(--fg3)" }}>uint256</td><td className="mono">{args.baseAssetAmount} <span className="tiny">· 1.0 SOL</span></td></tr>
        <tr><td className="mono">price</td><td className="mono" style={{ color: "var(--fg3)" }}>uint256</td><td className="mono">{args.price} <span className="tiny">· market order</span></td></tr>
      </tbody>
    </table>
  </div>
);

const RawTx = () => {
  const chainId = useActiveChainId();
  return (
  <pre className="mono" style={{ fontSize: 11, lineHeight: 1.6, padding: 16, background: "var(--rome-paper)", borderRadius: 8, overflowX: "auto", margin: 0 }}>
{`{
  "hash": "${RECEIPT.hash}",
  "from": "${RECEIPT.from}",
  "to": "${RECEIPT.to}",
  "value": "0x0",
  "gasLimit": "0x6aed1",
  "gasPrice": "0x3b9aca00",
  "data": "0xa7b8c9d00000000000000000000000000000000000000000000000000000000000000000...",
  "chainId": ${chainId},
  "nonce": 142,
  "cpi": {
    "program": "drift_v2",
    "accounts_touched": 12,
    "cu_consumed": 284219,
    "signers": ["4f56ad02da294f6d…"]
  }
}`}
  </pre>
  );
};

export { TxReceipt };
