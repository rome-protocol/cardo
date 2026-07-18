#!/usr/bin/env node
// Mango v4 bank discovery on Solana devnet.
//
// Lists Bank accounts grouped by mint, with optional filters. Use this
// to pick a target Group + Bank when wiring `/lend` or any other Mango
// adapter page.
//
// Usage:
//   node scripts/probe-mango-banks.mjs [--mint=<bs58>] [--group=<bs58>]
//
// Example — list all SOL banks:
//   node scripts/probe-mango-banks.mjs --mint=So11111111111111111111111111111111111111112
//
// Example — list every bank in one Group:
//   node scripts/probe-mango-banks.mjs --group=55b3nWhitDWMwAMnhkxMmYNfbZDXzAm6SfSgfoAp3qni
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md

import { PublicKey } from '@solana/web3.js';

const RPC = process.env.SOLANA_RPC || 'https://api.devnet.solana.com';
const MANGO_V4 = '4MangoMjqJ2firMokCjjGgoK8d4MXcrgL7XJaL3w6fVg';
// Bank account discriminator [142, 49, 166, 242, 50, 66, 97, 188] → bs58
const BANK_DISC_BS58 = 'QnTef4UXSzF';

function parseArgs() {
  const out = { mint: null, group: null };
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--(\w+)=(.+)$/);
    if (!m) continue;
    if (m[1] === 'mint') out.mint = m[2];
    else if (m[1] === 'group') out.group = m[2];
  }
  return out;
}

async function main() {
  const { mint, group } = parseArgs();
  console.log(`RPC: ${RPC}`);
  console.log(
    `filter: ${mint ? `mint=${mint}` : 'any mint'} / ${group ? `group=${group}` : 'any group'}`,
  );

  const filters = [{ memcmp: { offset: 0, bytes: BANK_DISC_BS58 } }];
  if (group) filters.push({ memcmp: { offset: 8, bytes: group } });
  if (mint) filters.push({ memcmp: { offset: 56, bytes: mint } });

  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getProgramAccounts',
      params: [
        MANGO_V4,
        {
          encoding: 'base64',
          filters,
          dataSlice: { offset: 0, length: 152 },
        },
      ],
    }),
  });
  const json = await r.json();
  const banks = json.result || [];
  console.log(`raw bank count: ${banks.length}`);

  const decoded = banks.map((b) => {
    const data = Buffer.from(b.account.data[0], 'base64');
    return {
      bank: b.pubkey,
      group: new PublicKey(data.subarray(8, 40)).toBase58(),
      name: data.subarray(40, 56).toString('utf8').replace(/\0+$/, ''),
      mint: new PublicKey(data.subarray(56, 88)).toBase58(),
      vault: new PublicKey(data.subarray(88, 120)).toBase58(),
      oracle: new PublicKey(data.subarray(120, 152)).toBase58(),
    };
  });

  console.log('\nBanks:');
  for (const b of decoded) {
    console.log(`  bank:   ${b.bank}`);
    console.log(`    name: ${JSON.stringify(b.name)}   mint: ${b.mint}`);
    console.log(`    group: ${b.group}`);
    console.log(`    vault: ${b.vault}`);
    console.log(`    oracle: ${b.oracle}`);
    console.log();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
