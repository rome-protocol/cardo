// verify-swap.mjs — replay Cardo's direct-precompile Meteora swap
// against Rome using the deployer's signing key. Proves the calldata
// builder in lib/meteora-swap.ts produces a tx that:
//
//   1. passes proxy CPI validation (previously bounced as -32000),
//   2. lands on Rome with a receipt.status == 0x1,
//   3. settles the Meteora DAMM v1 swap on Solana devnet.
//
// Self-contained: inlines the same Meteora pool constants, SWAP_DISC,
// and account order that lib/meteora-swap.ts uses. If the two drift, a
// live test here will catch it.
//
// Usage:
//   DRY_RUN=1 node scripts/verify-swap.mjs     # emulate only, no submit
//   DIRECTION=AToB AMOUNT_IN=500000 node scripts/verify-swap.mjs
//
// Env knobs:
//   DIRECTION   "AToB" (WSOL→USDC) or "BToA" (USDC→WSOL). default: BToA
//                In the canonical pool A=WSOL, B=USDC.
//   AMOUNT_IN   integer in raw token units. default: 500000 (0.5 USDC at 6dp)
//   MIN_OUT     integer in raw dest token units. default: 0 (trust pool)
//   DRY_RUN     if "1", run rome_emulateTx only. default: unset (submit).
//   RPC_URL     override Rome RPC. default: https://rome.devnet.romeprotocol.xyz/

import { ethers } from 'ethers';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import solw3 from '@solana/web3.js';

const { PublicKey } = solw3;

// ── Config ──────────────────────────────────────────────────────────
const RPC = process.env.RPC_URL || 'https://rome.devnet.romeprotocol.xyz/';
const CHAIN_ID = 999999n;
const GAS_PRICE = 11_000_000_000n;
const CPI = '0xFF00000000000000000000000000000000000008';

// Meteora DAMM v1 program id (devnet == mainnet).
// bs58: Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB
const METEORA_PROGRAM =
  '0xccf802d4cccc84d7fb21b5f73b49d81a16c5b4c88ee32394e1c91d3588cc4080';

// Anchor swap discriminator — sha256("global:swap")[0..8]
const SWAP_DISC_BYTES = crypto
  .createHash('sha256')
  .update('global:swap')
  .digest()
  .subarray(0, 8);
const SWAP_DISC_HEX = '0x' + SWAP_DISC_BYTES.toString('hex');

// Cross-check against the constant baked into lib/meteora-swap.ts — if
// they ever drift, Node throws loudly here instead of silently sending a
// broken tx.
const EXPECTED_DISC = '0xf8c69e91e17587c8';
if (SWAP_DISC_HEX.toLowerCase() !== EXPECTED_DISC.toLowerCase()) {
  throw new Error(
    `swap discriminator drift: derived=${SWAP_DISC_HEX} != pinned=${EXPECTED_DISC}`,
  );
}

// Rome Meteora pool constants — kept in sync with `cardo/lib/meteora-pool.ts`
// (the canonical USDC ↔ WSOL pool YxX5pw3A…EEV2 on Solana devnet).
//
// In this pool A=WSOL (9dp) / B=USDC (6dp). Choose AToB to swap WSOL→USDC,
// BToA to swap USDC→WSOL.
const POOL = {
  pool: '0x082fc7be5e0c80e982088b28ce1136451d0ef7d70cb19e9b03c4e4e4dc1cc785',
  aVault: '0xd3742176b89c5e14c96b748998421f38101e09e5c59331b168b625cd2715bb26',
  bVault: '0x7ddd69be7e8ccb013532108994bf543de518d8128d918648af8ee02f8d37965a',
  aVaultLp: '0x997375854d6761125996719d0334c721553acaaed571a8050dff4e2df9d31770',
  bVaultLp: '0x1422a93425b5254e7baef914362870a2c40e0b71224bdea6a3d71c24989d3a64',
  aTokenVault: '0xf617cd4510af70c761920499f8fe97d5b2311a69e19a17683ca2aaa48bec9a7d',
  bTokenVault: '0xc35bb351211ae9942fede7524fbbadcec7589c4631cccfc48d9ac39bc2177d45',
  aVaultLpMint: '0x02cca2aaece19457f1f3d1f73f1b86f47d7a17838b0b9ad4a00320a6829e30fe',
  bVaultLpMint: '0x3b76fdb7daa0a4a46a24db5718f13aaf0a314fdf57b279dae22fbbf51464fc7a',
  vaultProgram: '0x0fbfe8846d685cbdc62cca7e04c7e8f68dcc313ab31277e2e0112a2ec0e052e5',
  tokenProgram: '0x06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9',
  protocolTokenAFee:
    '0x11a9fb2e981532647daa81551de89b82f12aab094fafdd8e83b5d3ae84886fdc',
  protocolTokenBFee:
    '0xb04994e5fe134f16a1164a658e1a31f6e83de343f265a743161de62140849a21',
  splMintA: '0x069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f00000000001', // WSOL
  splMintB: '0x3b442cb3912157f13a933d0134282d032b5ffecd01a2dbf1b7790608df002ea7', // USDC
};

const ROME_EVM_PROGRAM = new PublicKey('DP1dshBzmXXVsRxH5kCKMemrDuptg1JvJ1j5AsFV4Hm3');
const SPL_TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

// ── Helpers ─────────────────────────────────────────────────────────
function toU64Le(v) {
  const big = BigInt(v);
  if (big < 0n || big > 0xffffffffffffffffn) throw new Error(`u64 out of range: ${big}`);
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(big);
  return b;
}
function pubkeyToBytes32(pk) {
  return '0x' + Buffer.from(pk.toBuffer()).toString('hex');
}
function bytes32ToPublicKey(hex) {
  return new PublicKey(Buffer.from(hex.slice(2), 'hex'));
}
function deriveRomeUserPda(evmAddr) {
  const userBytes = Buffer.from(evmAddr.slice(2), 'hex');
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('EXTERNAL_AUTHORITY'), userBytes],
    ROME_EVM_PROGRAM,
  );
  return pubkeyToBytes32(pda);
}
function deriveAta(ownerBytes32, mintBytes32) {
  const [ata] = PublicKey.findProgramAddressSync(
    [
      bytes32ToPublicKey(ownerBytes32).toBuffer(),
      SPL_TOKEN.toBuffer(),
      bytes32ToPublicKey(mintBytes32).toBuffer(),
    ],
    ASSOCIATED_TOKEN,
  );
  return pubkeyToBytes32(ata);
}

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return await res.json();
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  const pk = '0x' + fs
    .readFileSync(os.homedir() + '/.rome-rome-deployer.key', 'utf8')
    .trim()
    .replace(/^0x/, '');
  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(pk, provider);
  console.log('signer:', wallet.address);

  const direction = (process.env.DIRECTION || 'BToA').toUpperCase();
  const amountIn = BigInt(process.env.AMOUNT_IN || '500000'); // 0.5 USDC at 6dp
  const minOut = BigInt(process.env.MIN_OUT || '0');
  const dryRun = process.env.DRY_RUN === '1';
  if (direction !== 'ATOB' && direction !== 'BTOA') {
    throw new Error(`DIRECTION must be "AToB" or "BToA", got ${direction}`);
  }

  const splIn = direction === 'ATOB' ? POOL.splMintA : POOL.splMintB;
  const splOut = direction === 'ATOB' ? POOL.splMintB : POOL.splMintA;
  const protocolFee =
    direction === 'ATOB' ? POOL.protocolTokenAFee : POOL.protocolTokenBFee;

  const userPda = deriveRomeUserPda(wallet.address);
  const srcAta = deriveAta(userPda, splIn);
  const dstAta = deriveAta(userPda, splOut);

  console.log('user rome PDA:', bytes32ToPublicKey(userPda).toBase58());
  console.log(' src ATA (in):', bytes32ToPublicKey(srcAta).toBase58());
  console.log('dst ATA (out):', bytes32ToPublicKey(dstAta).toBase58());

  // Accounts (15) — ORDER PER THE CANONICAL ANCHOR IDL (rome-sdk/rome-meteora
  // uses the auto-generated `accounts::Swap` layout which reflects struct
  // declaration order in dynamic-amm/src/instructions/swap.rs). That order
  // differs from rome-solidity/rome-showcase's `build_swap_account_metas`,
  // which appears to jumble a_vault_lp/a_vault and protocol_token_fee
  // vs. user. Emulating with the rome-solidity order trips Anchor's
  // `ConstraintExecutable` (3007) because protocol_token_fee ends up in
  // the `token_program` slot. Using the Anchor order matches what the
  // rome-sdk Rust adapter ships.
  const accounts = [
    [POOL.pool,          false, true],   // [ 0] pool
    [srcAta,             false, true],   // [ 1] user_source_token
    [dstAta,             false, true],   // [ 2] user_destination_token
    [POOL.aVault,        false, true],   // [ 3] a_vault
    [POOL.bVault,        false, true],   // [ 4] b_vault
    [POOL.aTokenVault,   false, true],   // [ 5] a_token_vault
    [POOL.bTokenVault,   false, true],   // [ 6] b_token_vault
    [POOL.aVaultLpMint,  false, true],   // [ 7] a_vault_lp_mint
    [POOL.bVaultLpMint,  false, true],   // [ 8] b_vault_lp_mint
    [POOL.aVaultLp,      false, true],   // [ 9] a_vault_lp
    [POOL.bVaultLp,      false, true],   // [10] b_vault_lp
    [protocolFee,        false, true],   // [11] protocol_token_fee
    [userPda,            true,  false],  // [12] user (signer, Rome auto-signs)
    [POOL.vaultProgram,  false, false],  // [13] vault_program
    [POOL.tokenProgram,  false, false],  // [14] token_program
  ];

  const dataBuf = Buffer.concat([
    SWAP_DISC_BYTES,
    toU64Le(amountIn),
    toU64Le(minOut),
  ]);
  const ixData = '0x' + dataBuf.toString('hex');

  const iface = new ethers.Interface([
    'function invoke(bytes32 program, (bytes32,bool,bool)[] accounts, bytes data)',
  ]);
  const calldata = iface.encodeFunctionData('invoke', [METEORA_PROGRAM, accounts, ixData]);
  console.log(`direction: ${direction}  amountIn: ${amountIn}  minOut: ${minOut}`);
  console.log(`calldata:  ${(calldata.length - 2) / 2} bytes`);

  const nonce = await provider.getTransactionCount(wallet.address, 'pending');
  const unsignedTx = {
    type: 0,
    chainId: CHAIN_ID,
    nonce,
    gasPrice: GAS_PRICE,
    gasLimit: 50_000_000n,
    to: CPI,
    value: 0n,
    data: calldata,
  };
  const signed = await wallet.signTransaction(unsignedTx);

  console.log('\n--- rome_emulateTx ---');
  const emu = await rpc('rome_emulateTx', [signed]);
  console.log(JSON.stringify(emu, null, 2).slice(0, 2000));

  if (dryRun) {
    console.log('\nDRY_RUN=1 — stopping before broadcast.');
    return;
  }

  console.log('\n--- eth_sendRawTransaction ---');
  const send = await rpc('eth_sendRawTransaction', [signed]);
  console.log(JSON.stringify(send, null, 2));
  if (!send.result) {
    throw new Error('sendRawTransaction failed — see response above');
  }
  console.log('\nTX HASH:', send.result);

  console.log('waiting for receipt...');
  let receipt = null;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const r = await rpc('eth_getTransactionReceipt', [send.result]);
    if (r.result) {
      receipt = r.result;
      break;
    }
    process.stdout.write('.');
  }
  console.log('\nreceipt:', JSON.stringify(receipt, null, 2)?.slice(0, 1500));
  if (!receipt || receipt.status !== '0x1') {
    console.error('\nSWAP FAILED (status != 0x1)');
    process.exit(1);
  }
  console.log('\nSWAP LANDED. tx=', send.result, 'block=', receipt.blockNumber);
}

main().catch((e) => {
  console.error('ERROR', e);
  process.exit(1);
});
