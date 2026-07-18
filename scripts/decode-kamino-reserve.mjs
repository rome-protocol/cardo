// decode-kamino-reserve.mjs — read a Kamino Reserve account on Solana
// devnet and print every interesting field by label, not by offset.
//
// Per integration playbook §4b.3: write the decoder script the first
// time you decode. Manual hex offset arithmetic is a tax. This is the
// canonical decoder for the Reserve struct; reuse for any new reserve
// the UI surfaces.
//
// Field offsets are documented in
//   the docs/active/technical/2026-04-25-cardo-lend-kamino-triage.md §7.3
// and were probed empirically against both reserves of the chosen
// devnet market on 2026-04-25.
//
// Usage:
//   node scripts/decode-kamino-reserve.mjs                          # default: USDC reserve of Rome Kamino Main
//   RESERVE=<base58 address> node scripts/decode-kamino-reserve.mjs # arbitrary reserve

import { PublicKey } from '@solana/web3.js';

const RPC = 'https://api.devnet.solana.com';
const DEFAULT_RESERVE = 'DHP5csgS8ba2dFAqgM5dqNXoUw3x9EWaPwYXVACQ4Wxn'; // Rome Kamino Main USDC

const reserve = process.env.RESERVE || DEFAULT_RESERVE;

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return res.json();
}

function readPubkey(data, off) {
  return new PublicKey(data.slice(off, off + 32)).toBase58();
}
function readU64Le(data, off) {
  return data.readBigUInt64LE(off);
}
function readI64Le(data, off) {
  return data.readBigInt64LE(off);
}

(async () => {
  const json = await rpc('getAccountInfo', [reserve, { encoding: 'base64' }]);
  if (!json.result?.value) {
    console.error('Reserve not found:', reserve);
    process.exit(1);
  }
  const acc = json.result.value;
  const data = Buffer.from(acc.data[0], 'base64');
  console.log('━━━ Reserve', reserve, '━━━');
  console.log('  owner:    ', acc.owner);
  console.log('  size:     ', data.length, 'bytes');
  console.log('  lamports: ', acc.lamports);
  console.log('');

  const disc = data.slice(0, 8).toString('hex');
  console.log('  discriminator: 0x' + disc, disc === '2bf2ccca1af73b7f' ? '✓ Reserve' : '✗ NOT a Reserve');
  console.log('');

  // LastUpdate { slot: u64, stale: u8 / u64 padded }
  console.log('  --- LastUpdate ---');
  console.log('    slot:          ', readU64Le(data, 8));
  console.log('    stale:         ', data.readUInt8(16));
  console.log('');

  console.log('  --- Identity ---');
  console.log('    lending_market:', readPubkey(data, 32));
  console.log('    farm_collateral:', readPubkey(data, 40));
  console.log('    farm_debt:     ', readPubkey(data, 48));
  console.log('');

  console.log('  --- ReserveLiquidity ---');
  console.log('    mint_pubkey:   ', readPubkey(data, 128));
  console.log('    supply_vault:  ', readPubkey(data, 136));
  console.log('    fee_vault:     ', readPubkey(data, 144));
  console.log('    market_price_oracle (Pyth):', readPubkey(data, 152));
  console.log('');

  // ReserveLiquidity struct continues with available_amount (u64),
  // borrowed_amount_sf (u128), market_price_sf (u128), etc.
  // The next 8-aligned u64 after the four pubkeys (160) is where
  // numeric fields begin. We dump the raw values so a reader can
  // sanity-check liquidity is non-zero.
  console.log('  --- Liquidity numeric fields (raw) ---');
  console.log('    @ 256 (u64) =', readU64Le(data, 256));
  console.log('    @ 264 (u64) =', readU64Le(data, 264));
  console.log('    @ 272 (u64) =', readU64Le(data, 272));
  console.log('    @ 280 (u64) =', readU64Le(data, 280));
  console.log('    @ 288 (u64) =', readU64Le(data, 288));
  console.log('    @ 296 (u64) =', readU64Le(data, 296));
  console.log('');
  console.log('  (For a precise field map of the rest of the struct,');
  console.log('   open kamino-finance/klend `state/reserve.rs`.)');
})().catch((e) => { console.error(e); process.exit(1); });
