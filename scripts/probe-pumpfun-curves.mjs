#!/usr/bin/env node
// Pump.fun bonding-curve discovery on Solana devnet.
//
// Lists BondingCurve accounts that aren't yet graduated
// (`complete=false`), ranked by `real_sol_reserves` (more = more
// active). Use this to pick a target curve when wiring a Cardo
// `/swap-pumpfun` page.
//
// Usage:
//   node scripts/probe-pumpfun-curves.mjs [--limit=10] [--include-complete]
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md

import { PublicKey } from '@solana/web3.js';

const RPC = process.env.SOLANA_RPC || 'https://api.devnet.solana.com';
const PUMP_FUN = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const BONDING_CURVE_DISC_BS58 = '4y6pru6YvC7';

function parseArgs() {
  const out = { limit: 10, includeComplete: false };
  for (const a of process.argv.slice(2)) {
    if (a === '--include-complete') out.includeComplete = true;
    const m = a.match(/^--(\w+)=(.+)$/);
    if (!m) continue;
    if (m[1] === 'limit') out.limit = parseInt(m[2], 10);
  }
  return out;
}

async function main() {
  const { limit, includeComplete } = parseArgs();
  console.log(`RPC: ${RPC}`);
  console.log(`limit: ${limit} | include-complete: ${includeComplete}`);

  // Pull only the first 81 bytes — enough to decode the layout we care
  // about. 77K curves * 81 bytes = ~6MB, comfortable.
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getProgramAccounts',
      params: [
        PUMP_FUN,
        {
          encoding: 'base64',
          filters: [{ memcmp: { offset: 0, bytes: BONDING_CURVE_DISC_BS58 } }],
          dataSlice: { offset: 0, length: 81 },
        },
      ],
    }),
  });
  const json = await r.json();
  const accts = json.result || [];
  console.log(`raw curve count: ${accts.length}`);

  const decoded = [];
  for (const a of accts) {
    const data = Buffer.from(a.account.data[0], 'base64');
    if (data.length < 81) continue;
    const complete = data[48] === 1;
    if (complete && !includeComplete) continue;
    decoded.push({
      pubkey: a.pubkey,
      virtualTokenReserves: data.readBigUInt64LE(8),
      virtualSolReserves: data.readBigUInt64LE(16),
      realTokenReserves: data.readBigUInt64LE(24),
      realSolReserves: data.readBigUInt64LE(32),
      tokenTotalSupply: data.readBigUInt64LE(40),
      complete,
      creator: new PublicKey(data.subarray(49, 81)).toBase58(),
    });
  }

  decoded.sort((a, b) =>
    Number(BigInt(b.realSolReserves) - BigInt(a.realSolReserves)),
  );
  const top = decoded.slice(0, limit);

  console.log('\nTop curves (sorted by real_sol_reserves):');
  for (const c of top) {
    console.log(`  curve: ${c.pubkey}`);
    console.log(
      `    real_sol: ${(Number(c.realSolReserves) / 1e9).toFixed(4)} SOL  ` +
        `complete: ${c.complete}  creator: ${c.creator}`,
    );
    console.log(
      `    virtual_token: ${c.virtualTokenReserves}  virtual_sol: ${c.virtualSolReserves}`,
    );
  }
  console.log(`\nTotal active (complete=false): ${decoded.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
