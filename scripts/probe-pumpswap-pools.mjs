#!/usr/bin/env node
// PumpSwap pool discovery against Solana devnet.
//
// Lists Pool accounts ranked by lp_supply, optionally filtered by base or
// quote mint. Use this to pick a target pool when wiring up
// `/swap-pumpswap`.
//
// Usage:
//   node scripts/probe-pumpswap-pools.mjs [--quote=<bs58>] [--base=<bs58>] [--limit=10]
//
// Example — top 10 WSOL-paired pools:
//   node scripts/probe-pumpswap-pools.mjs --quote=So11111111111111111111111111111111111111112
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md

import { PublicKey } from '@solana/web3.js';

const RPC = process.env.SOLANA_RPC || 'https://api.devnet.solana.com';
const PUMPSWAP_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

// Pool account discriminator (Anchor): [241, 154, 109, 4, 17, 177, 109, 188]
// bs58 of those 8 bytes (used for getProgramAccounts memcmp filter).
const POOL_DISC_BS58 = 'hQrXeCntzbV';

function parseArgs() {
  const out = { limit: 10, quote: null, base: null };
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--(\w+)=(.+)$/);
    if (!m) continue;
    if (m[1] === 'limit') out.limit = parseInt(m[2], 10);
    else if (m[1] === 'quote') out.quote = m[2];
    else if (m[1] === 'base') out.base = m[2];
  }
  return out;
}

async function main() {
  const { limit, quote, base } = parseArgs();
  console.log(`RPC: ${RPC}`);
  console.log(
    `filter: ${base ? `base=${base}` : 'any base'} / ${quote ? `quote=${quote}` : 'any quote'}; top ${limit} by lp_supply`,
  );

  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getProgramAccounts',
      params: [
        PUMPSWAP_PROGRAM,
        {
          encoding: 'base64',
          filters: [{ memcmp: { offset: 0, bytes: POOL_DISC_BS58 } }],
          dataSlice: { offset: 8, length: 237 },
        },
      ],
    }),
  });
  const json = await res.json();
  const accts = json.result || [];
  console.log(`raw pool count: ${accts.length}`);

  const pools = [];
  for (const a of accts) {
    const data = Buffer.from(a.account.data[0], 'base64');
    let off = 1 + 2; // pool_bump + index
    const creator = new PublicKey(data.subarray(off, off + 32)); off += 32;
    const baseMint = new PublicKey(data.subarray(off, off + 32)); off += 32;
    const quoteMint = new PublicKey(data.subarray(off, off + 32)); off += 32;
    off += 32; // lp_mint
    const poolBaseTokenAccount = new PublicKey(data.subarray(off, off + 32)); off += 32;
    const poolQuoteTokenAccount = new PublicKey(data.subarray(off, off + 32)); off += 32;
    const lpSupply = data.readBigUInt64LE(off); off += 8;
    const coinCreator = new PublicKey(data.subarray(off, off + 32));

    if (base && baseMint.toBase58() !== base) continue;
    if (quote && quoteMint.toBase58() !== quote) continue;
    if (lpSupply <= 1000n) continue;

    pools.push({
      pool: a.pubkey,
      creator: creator.toBase58(),
      baseMint: baseMint.toBase58(),
      quoteMint: quoteMint.toBase58(),
      poolBaseTokenAccount: poolBaseTokenAccount.toBase58(),
      poolQuoteTokenAccount: poolQuoteTokenAccount.toBase58(),
      lpSupply: lpSupply.toString(),
      coinCreator: coinCreator.toBase58(),
    });
  }

  pools.sort((a, b) => Number(BigInt(b.lpSupply) - BigInt(a.lpSupply)));
  const top = pools.slice(0, limit);

  // Decorate top results with vault balances so the operator can pick a
  // pool that's actually tradeable.
  const vaultPubkeys = top.flatMap((p) => [
    p.poolBaseTokenAccount,
    p.poolQuoteTokenAccount,
  ]);
  let vaultMap = {};
  if (vaultPubkeys.length) {
    const r = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getMultipleAccounts',
        params: [vaultPubkeys, { encoding: 'jsonParsed' }],
      }),
    });
    const j = await r.json();
    for (let i = 0; i < vaultPubkeys.length; i++) {
      const v = j.result?.value?.[i];
      const amt = v?.data?.parsed?.info?.tokenAmount;
      vaultMap[vaultPubkeys[i]] = amt
        ? `${amt.uiAmountString} (decimals=${amt.decimals})`
        : '?';
    }
  }

  console.log('\nTop pools (filtered, sorted by lp_supply):');
  for (const p of top) {
    console.log(`  pool: ${p.pool}`);
    console.log(`    base:  ${p.baseMint}  vault=${vaultMap[p.poolBaseTokenAccount]}`);
    console.log(`    quote: ${p.quoteMint}  vault=${vaultMap[p.poolQuoteTokenAccount]}`);
    console.log(`    lp_supply: ${p.lpSupply}  coin_creator: ${p.coinCreator}`);
    console.log();
  }
  console.log(`Total matches with lp_supply > 1000: ${pools.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
