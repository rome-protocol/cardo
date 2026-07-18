'use client';
// V3 designer defined ForAgents inline inside Cardo.html rather than as
// a separate src/ file. Lifted here verbatim (byte-preserved markup/
// styles) so the /for-agents route retains its visual layer.

import React from 'react';
import { Eyebrow } from '../primitives';

const ForAgents = ({ onNav }) => (
  <main className="container" style={{ padding: "40px 32px 96px", maxWidth: 960 }}>
    <Eyebrow>For agents · MCP + JSON-RPC</Eyebrow>
    <h1 className="h1" style={{ marginTop: 10 }}>Cardo is <em>machine-readable.</em></h1>
    <p className="lede" style={{ marginTop: 14, maxWidth: 640 }}>
      Every surface exposes typed capabilities. Connect via MCP or hit the REST endpoints directly — an agent can quote, sign, and settle against Solana protocols without touching a wallet UI.
    </p>
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginTop: 36 }}>
      <div className="card" style={{ padding: 22 }}>
        <Eyebrow>MCP</Eyebrow>
        <div className="serif" style={{ fontSize: 22, margin: "6px 0 12px" }}>Model Context Protocol</div>
        <pre className="mono" style={{ fontSize: 12, background: "var(--rome-paper)", padding: 14, borderRadius: 8, margin: 0, overflowX: "auto" }}>{`{
  "mcpServers": {
    "cardo": {
      "url": "https://cardo.rome.builders/mcp"
    }
  }
}`}</pre>
        <p className="small" style={{ marginTop: 12 }}>Tools: <span className="mono" style={{ fontSize: 12 }}>rome_cross.swap_a_to_b</span>, <span className="mono" style={{ fontSize: 12 }}>rome_kamino.deposit</span>, <span className="mono" style={{ fontSize: 12 }}>rome_drift.placePerpOrder</span>…</p>
      </div>
      <div className="card" style={{ padding: 22 }}>
        <Eyebrow>JSON-RPC</Eyebrow>
        <div className="serif" style={{ fontSize: 22, margin: "6px 0 12px" }}>HTTPS endpoints</div>
        <pre className="mono" style={{ fontSize: 12, background: "var(--rome-paper)", padding: 14, borderRadius: 8, margin: 0, overflowX: "auto" }}>{`POST /apps/rome-cross/quote
{
  "amount_in": "1000000",
  "min_out": "0"
}`}</pre>
      </div>
    </div>
  </main>
);

export { ForAgents };
