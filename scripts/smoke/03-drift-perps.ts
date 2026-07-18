// TDD smoke: place_perp_order on Drift Perps SOL-PERP via Rome's CPI
// precompile, eth_call (no signing). Uses the user's already-bootstrapped
// Drift User (`E5EV3joK…`) which has 0 USDC collateral.
//
// What we expect to see:
//   * If Mollusk emulator runs Drift cleanly: a Drift program error like
//     `Custom(6010)` (InsufficientCollateral) — calldata correct,
//     missing only collateral. Adapter is shippable; user just needs to
//     deposit USDC first.
//   * If Mollusk hits the same Custom(6087) bug as /lend-drift Spot
//     deposit: confirms the bug affects Drift universally, not just
//     Spot. Then perps is ALSO blocked under emulation.
//   * If we get `account not found: <X>`: a bug in our calldata
//     (missing account, wrong order). We fix and retry.
//
// The third case would mean Drift Perps adapter works; the first two
// quantify what blocker remains.

import { encodeFunctionData, concat, type Hex } from 'viem';
import { CPI_INVOKE_ABI, CPI_PRECOMPILE, type AccountMeta } from '../../lib/cpi-precompile';
import { deriveRomeUserPda, pubkeyBs58ToBytes32, bytes32ToPublicKey } from '../../lib/solana-pda';
import { DRIFT_PROGRAM, DRIFT_STATE_SEED, SPOT_MARKET_SEED, USER_SEED, USER_STATS_SEED } from '../../lib/drift-program';
import { PublicKey } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha256';

const USER = process.env.USER_EVM_ADDR || '0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562';
const RPC = process.env.ROME_RPC_URL || 'https://rome.devnet.romeprotocol.xyz/';

// SOL-PERP market on Drift devnet — verified active 2026-04-25 (last tx <1h ago).
const SOL_PERP_MARKET_BS58 = '8UJgxaiQx5nTrdDgph5FiahMmzduuLTLf5WmsPegYA6W';
const SOL_PERP_MARKET_INDEX = 0;

// Drift's discriminator for `place_perp_order` (sha256("global:place_perp_order")[..8])
function disc(name: string): Hex {
  const h = sha256(new TextEncoder().encode(`global:${name}`));
  return ('0x' + Buffer.from(h.subarray(0, 8)).toString('hex')) as Hex;
}
const PLACE_PERP_ORDER_DISC = disc('place_perp_order');

// Derive Drift State PDA: PDA(["drift_state"], program)
function deriveDriftState(): Hex {
  const program = bytes32ToPublicKey(DRIFT_PROGRAM);
  const [pda] = PublicKey.findProgramAddressSync([DRIFT_STATE_SEED], program);
  return pubkeyBs58ToBytes32(pda.toBase58());
}

// Derive User PDA: PDA(["user", authority, sub_account_id_le], program)
function deriveDriftUser(authority: Hex, subAcct: number): Hex {
  const program = bytes32ToPublicKey(DRIFT_PROGRAM);
  const auth = bytes32ToPublicKey(authority);
  const subBuf = Buffer.alloc(2);
  subBuf.writeUInt16LE(subAcct, 0);
  const [pda] = PublicKey.findProgramAddressSync([USER_SEED, auth.toBuffer(), subBuf], program);
  return pubkeyBs58ToBytes32(pda.toBase58());
}

// Read SOL-PERP market's `amm.oracle` field. PerpMarket layout:
//   8..40 pubkey, 40..1024 amm. Within AMM, oracle pubkey is at offset 8
//   from amm start, so absolute offset 48.
async function readPerpMarketOracle(marketBs58: string): Promise<string> {
  const r = await fetch('https://api.devnet.solana.com', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'getAccountInfo',
      params: [marketBs58, { encoding: 'base64' }],
    }),
  });
  const j = await r.json();
  const buf = Buffer.from(j.result.value.data[0], 'base64');
  // amm starts at offset 40. oracle is 4th field (after last_oracle_normalised_price ts etc).
  // Per drift-labs amm.rs, `oracle: Pubkey` is one of the first AMM fields.
  // Try offsets near the start of AMM. Typical Drift AMM: oracle is at AMM offset 0 (i.e., 40).
  const candidate = new PublicKey(buf.subarray(40, 72)).toBase58();
  return candidate;
}

// Borsh encode OrderParams. Per Drift IDL:
//   order_type: u8     (Limit=2)
//   market_type: u8    (Perp=1)
//   direction: u8      (Long=0, Short=1)
//   user_order_id: u8
//   base_asset_amount: u64
//   price: u64
//   market_index: u16
//   reduce_only: bool
//   post_only: u8 (None=0, MustPostOnly=1, TryPostOnly=2)
//   bit_flags: u8
//   max_ts: Option<i64>
//   trigger_price: Option<u64>
//   trigger_condition: u8 (Above=0)
//   oracle_price_offset: Option<i32>
//   auction_duration: Option<u8>
//   auction_start_price: Option<i64>
//   auction_end_price: Option<i64>
function encodeOrderParams(opts: {
  orderType: number;
  marketType: number;
  direction: number;
  baseAssetAmount: bigint;
  price: bigint;
  marketIndex: number;
}): Hex {
  const buf = Buffer.alloc(128);
  let off = 0;
  buf.writeUInt8(opts.orderType, off); off += 1;
  buf.writeUInt8(opts.marketType, off); off += 1;
  buf.writeUInt8(opts.direction, off); off += 1;
  buf.writeUInt8(0, off); off += 1; // user_order_id
  buf.writeBigUInt64LE(opts.baseAssetAmount, off); off += 8;
  buf.writeBigUInt64LE(opts.price, off); off += 8;
  buf.writeUInt16LE(opts.marketIndex, off); off += 2;
  buf.writeUInt8(0, off); off += 1; // reduce_only false
  buf.writeUInt8(0, off); off += 1; // post_only None
  buf.writeUInt8(0, off); off += 1; // bit_flags
  buf.writeUInt8(0, off); off += 1; // max_ts None
  buf.writeUInt8(0, off); off += 1; // trigger_price None
  buf.writeUInt8(0, off); off += 1; // trigger_condition Above
  buf.writeUInt8(0, off); off += 1; // oracle_price_offset None
  buf.writeUInt8(0, off); off += 1; // auction_duration None
  buf.writeUInt8(0, off); off += 1; // auction_start_price None
  buf.writeUInt8(0, off); off += 1; // auction_end_price None
  return ('0x' + buf.subarray(0, off).toString('hex')) as Hex;
}

async function main() {
  console.log(`user EVM:      ${USER}`);
  const userPda = deriveRomeUserPda(USER);
  console.log(`user Rome PDA: ${bytes32ToPublicKey(userPda).toBase58()}`);

  const state = deriveDriftState();
  const user = deriveDriftUser(userPda, 0);
  console.log(`Drift State PDA: ${bytes32ToPublicKey(state).toBase58()}`);
  console.log(`Drift User PDA:  ${bytes32ToPublicKey(user).toBase58()}`);

  const oracleBs58 = await readPerpMarketOracle(SOL_PERP_MARKET_BS58);
  console.log(`SOL-PERP oracle: ${oracleBs58}`);

  // USDC spot market PDA + its oracle. Drift's SDK always includes the
  // quote spot market in remaining_accounts for margin calc.
  const driftProgramPk = bytes32ToPublicKey(DRIFT_PROGRAM);
  const [usdcSpotMarketPk] = PublicKey.findProgramAddressSync(
    [SPOT_MARKET_SEED, Buffer.from([0, 0])],
    driftProgramPk,
  );
  const usdcSpotMarketBs58 = usdcSpotMarketPk.toBase58();
  console.log(`USDC spot market PDA: ${usdcSpotMarketBs58}`);

  // Read USDC spot market's oracle. SpotMarket layout has oracle at offset 8 (after disc).
  // Let me check by reading the account.
  const r2 = await fetch('https://api.devnet.solana.com', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'getAccountInfo',
      params: [usdcSpotMarketBs58, { encoding: 'base64' }],
    }),
  });
  const j2 = await r2.json();
  const usdcBuf = Buffer.from(j2.result.value.data[0], 'base64');
  const usdcOracle = new PublicKey(usdcBuf.subarray(40, 72)).toBase58();
  console.log(`USDC spot oracle:     ${usdcOracle}`);

  // Build place_perp_order ix
  // Accounts: state, user (mut), authority (signer), + remaining: perp_market (mut), oracle
  const accounts: AccountMeta[] = [
    { pubkey: state, is_signer: false, is_writable: false },
    { pubkey: user, is_signer: false, is_writable: true },
    { pubkey: userPda, is_signer: true, is_writable: false }, // authority = user PDA
    // Minimal: just the perp market we're targeting + its oracle.
    { pubkey: pubkeyBs58ToBytes32(SOL_PERP_MARKET_BS58), is_signer: false, is_writable: true },
    { pubkey: pubkeyBs58ToBytes32(oracleBs58), is_signer: false, is_writable: false },
  ];

  const orderParamsBytes = encodeOrderParams({
    orderType: 2,        // Limit
    marketType: 1,       // Perp
    direction: 0,        // Long (Buy)
    baseAssetAmount: 1_000_000n,    // 0.001 SOL (Drift uses 1e9 base unit precision)
    price: 1_000_000n,             // $1 (Drift uses 1e6 price precision)
    marketIndex: SOL_PERP_MARKET_INDEX,
  });

  const data = concat([PLACE_PERP_ORDER_DISC, orderParamsBytes]);
  console.log(`\nplace_perp_order data: ${data}`);

  const calldata = encodeFunctionData({
    abi: CPI_INVOKE_ABI,
    functionName: 'invoke',
    args: [DRIFT_PROGRAM, accounts, data],
  });

  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'eth_call',
      params: [{ from: USER, to: CPI_PRECOMPILE, data: calldata, gas: '0x2faf080' }, 'latest'],
    }),
  });
  const j = await res.json();

  if (j.error) {
    console.log(`\n❌ revert`);
    console.log(`  msg: ${j.error.message}`);
    if (j.error.data) console.log(`  data: ${j.error.data}`);
  } else {
    console.log(`\n✅ eth_call OK — result: ${j.result}`);
  }
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
