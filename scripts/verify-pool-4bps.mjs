// verify-pool-4bps.mjs — confirm the freshly-created USDC↔WSOL @ 4.0%
// Meteora pool is functional by:
//   1. Reading its on-chain state and printing the key fields (pool
//      address, LP mint, vaults, protocol fee accounts).
//   2. Submitting a tiny swap (default 0.01 USDC → WSOL) via Rome's
//      CPI precompile using the local deployer key. This proves the
//      pool's accounts deserialize, the swap CPI lands, and a receipt
//      with status==0x1 comes back.
//
// Pool was created via /pool/new on 2026-04-24 by user EOA
// 0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562 with bootstrap
// (1 USDC + 0.02 WSOL). Pool: 8qsPLsiKRtH5Wa7XwdsYP7jpRwnGLs82jdx3xnMSa9uJ.
//
// In this pool the caller (the user) chose A=USDC, B=WSOL — so
// `AToB` = USDC→WSOL, `BToA` = WSOL→USDC. Different from the canonical
// 0.25% pool (A=WSOL, B=USDC); see lib/meteora-pool.ts for that one.
//
// Usage:
//   DRY_RUN=1 node scripts/verify-pool-4bps.mjs       # state + emulate
//   DIRECTION=AToB AMOUNT_IN=10000 node scripts/verify-pool-4bps.mjs
//
// Env knobs:
//   DIRECTION   "AToB" (USDC→WSOL) or "BToA" (WSOL→USDC). default: AToB
//   AMOUNT_IN   raw token units. default: 10_000 (= 0.01 USDC at 6dp)
//   MIN_OUT     raw destination units. default: 0
//   DRY_RUN     "1" → emulate only, no submit. default: unset (submit).
//   RPC_URL     override Rome RPC.

import { ethers } from 'ethers';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import solw3 from '@solana/web3.js';

const { PublicKey, Connection } = solw3;

const RPC = process.env.RPC_URL || 'https://rome.devnet.romeprotocol.xyz/';
const SOL_RPC = 'https://api.devnet.solana.com';
const CHAIN_ID = 999999n;
const GAS_PRICE = 11_000_000_000n;
const CPI = '0xFF00000000000000000000000000000000000008';
const METEORA_PROGRAM =
  '0xccf802d4cccc84d7fb21b5f73b49d81a16c5b4c88ee32394e1c91d3588cc4080';

const SWAP_DISC = crypto
  .createHash('sha256')
  .update('global:swap')
  .digest()
  .subarray(0, 8);

// The new 4.0% pool. A = USDC, B = WSOL (per pool state below).
// Verify-step #1 below also re-reads these from chain and asserts
// they match — so if this drifts, the script self-detects.
const POOL = {
  pool:               '0x7486a877255c719ee314bebf60ffcc608d61d49308c51d6761d9e69fca8badf1',
  lpMint:             '0x59e868591f9d41a9df909128f6e651cfea21bd0e6a3cb11f1b7b741d285a1f42',
  splMintA:           '0x3b442cb3912157f13a933d0134282d032b5ffecd01a2dbf1b7790608df002ea7', // USDC
  splMintB:           '0x069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f00000000001', // WSOL
  aVault:             '0x7ddd69be7e8ccb013532108994bf543de518d8128d918648af8ee02f8d37965a', // USDC vault
  bVault:             '0xd3742176b89c5e14c96b748998421f38101e09e5c59331b168b625cd2715bb26', // WSOL vault
  aTokenVault:        '0xc35bb351211ae9942fede7524fbbadcec7589c4631cccfc48d9ac39bc2177d45', // USDC vault's token vault
  bTokenVault:        '0xf617cd4510af70c761920499f8fe97d5b2311a69e19a17683ca2aaa48bec9a7d', // WSOL vault's token vault
  aVaultLpMint:       '0x3b76fdb7daa0a4a46a24db5718f13aaf0a314fdf57b279dae22fbbf51464fc7a', // USDC vault's lp_mint (PDA-derived)
  bVaultLpMint:       '0x02cca2aaece19457f1f3d1f73f1b86f47d7a17838b0b9ad4a00320a6829e30fe', // WSOL vault's lp_mint (legacy non-PDA)
  aVaultLp:           '0xb838515dd19c8881fcef2992494a6829c85bc1f96de626e4bdd9a1b0be2b4d84', // [a_vault, pool] PDA in DAMM
  bVaultLp:           '0x0a2156ac8081e709692ce9d5ebbe850597e9aa39e88894c11754db60b0ca9923', // [b_vault, pool] PDA in DAMM
  protocolTokenAFee:  '0x49adddd479cdb24d8eccc0ba94e49e6fe65d6f8ff010f0adb6beb47c216a9ce0', // ["fee", USDC, pool] — 5xcXm…vdXD
  protocolTokenBFee:  '0xac4271af0bd1ab0a3dc264cd56748feb38c9b37bfb8d530f66fe76e2bd19591c', // ["fee", WSOL, pool] — CbRtU…3jaT
  vaultProgram:       '0x0fbfe8846d685cbdc62cca7e04c7e8f68dcc313ab31277e2e0112a2ec0e052e5',
  tokenProgram:       '0x06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9',
};

const ROME_EVM_PROGRAM = new PublicKey('DP1dshBzmXXVsRxH5kCKMemrDuptg1JvJ1j5AsFV4Hm3');
const SPL_TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

function toU64Le(v) {
  const big = BigInt(v);
  if (big < 0n || big > 0xffffffffffffffffn) throw new Error(`u64 out of range: ${big}`);
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(big);
  return b;
}
function pubkeyToBytes32(pk) { return '0x' + pk.toBuffer().toString('hex'); }
function bytes32ToPublicKey(hex) { return new PublicKey(Buffer.from(hex.slice(2), 'hex')); }
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

async function validatePoolState() {
  console.log('━━━ Step 1: Validate pool state ━━━');
  const conn = new Connection(SOL_RPC, 'confirmed');
  const poolInfo = await conn.getAccountInfo(bytes32ToPublicKey(POOL.pool));
  if (!poolInfo) throw new Error('Pool account not found on-chain');
  if (poolInfo.owner.toBase58() !== 'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB') {
    throw new Error(`Pool owner mismatch: ${poolInfo.owner.toBase58()}`);
  }
  console.log('  pool:        ', bytes32ToPublicKey(POOL.pool).toBase58());
  console.log('  size:        ', poolInfo.data.length, 'bytes');
  console.log('  owner:       ', poolInfo.owner.toBase58(), '✓');

  // Decode the relevant fields from pool state and assert they match
  // our hardcoded constants. Layout: 8 disc + 32 lp_mint + 32 a_mint
  // + 32 b_mint + 32 a_vault + 32 b_vault + 32 a_vault_lp + 32 b_vault_lp
  // = 8 + 32*7 = 232.
  const reads = [
    ['lp_mint',     8 + 32 * 0, POOL.lpMint],
    ['token_a_mint',8 + 32 * 1, POOL.splMintA],
    ['token_b_mint',8 + 32 * 2, POOL.splMintB],
    ['a_vault',     8 + 32 * 3, POOL.aVault],
    ['b_vault',     8 + 32 * 4, POOL.bVault],
    ['a_vault_lp',  8 + 32 * 5, POOL.aVaultLp],
    ['b_vault_lp',  8 + 32 * 6, POOL.bVaultLp],
  ];
  for (const [name, off, expected] of reads) {
    const onChain = '0x' + poolInfo.data.subarray(off, off + 32).toString('hex');
    const ok = onChain.toLowerCase() === expected.toLowerCase();
    console.log(`  ${name.padEnd(13)}`, bytes32ToPublicKey(onChain).toBase58(), ok ? '✓' : `✗ MISMATCH (expected ${expected})`);
    if (!ok) throw new Error(`${name} mismatch`);
  }

  // Read pool's vault token balances to verify it has liquidity.
  const aTokenInfo = await conn.getTokenAccountBalance(bytes32ToPublicKey(POOL.aTokenVault));
  const bTokenInfo = await conn.getTokenAccountBalance(bytes32ToPublicKey(POOL.bTokenVault));
  console.log('  token A vault USDC reserve:', aTokenInfo.value.uiAmount);
  console.log('  token B vault WSOL reserve:', bTokenInfo.value.uiAmount);
  console.log('');
}

async function main() {
  await validatePoolState();

  const pk = '0x' + fs.readFileSync(os.homedir() + '/.rome-rome-deployer.key', 'utf8').trim().replace(/^0x/, '');
  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(pk, provider);
  console.log('━━━ Step 2: Submit tiny swap ━━━');
  console.log('  signer:', wallet.address);

  const direction = (process.env.DIRECTION || 'AToB').toUpperCase();
  const amountIn = BigInt(process.env.AMOUNT_IN || '10000');  // 0.01 USDC at 6dp
  const minOut = BigInt(process.env.MIN_OUT || '0');
  const dryRun = process.env.DRY_RUN === '1';
  if (direction !== 'ATOB' && direction !== 'BTOA') {
    throw new Error(`DIRECTION must be "AToB" (USDC→WSOL) or "BToA" (WSOL→USDC), got ${direction}`);
  }

  const splIn = direction === 'ATOB' ? POOL.splMintA : POOL.splMintB;
  const splOut = direction === 'ATOB' ? POOL.splMintB : POOL.splMintA;
  const protocolFee = direction === 'ATOB' ? POOL.protocolTokenAFee : POOL.protocolTokenBFee;
  const userPda = deriveRomeUserPda(wallet.address);
  const srcAta = deriveAta(userPda, splIn);
  const dstAta = deriveAta(userPda, splOut);

  console.log('  user PDA:    ', bytes32ToPublicKey(userPda).toBase58());
  console.log('  src ATA(in): ', bytes32ToPublicKey(srcAta).toBase58());
  console.log('  dst ATA(out):', bytes32ToPublicKey(dstAta).toBase58());
  console.log('  direction:   ', direction, ' amountIn:', amountIn, ' minOut:', minOut);

  const accounts = [
    [POOL.pool,         false, true],
    [srcAta,            false, true],
    [dstAta,            false, true],
    [POOL.aVault,       false, true],
    [POOL.bVault,       false, true],
    [POOL.aTokenVault,  false, true],
    [POOL.bTokenVault,  false, true],
    [POOL.aVaultLpMint, false, true],
    [POOL.bVaultLpMint, false, true],
    [POOL.aVaultLp,     false, true],
    [POOL.bVaultLp,     false, true],
    [protocolFee,       false, true],
    [userPda,           true,  false],
    [POOL.vaultProgram, false, false],
    [POOL.tokenProgram, false, false],
  ];

  const data = Buffer.concat([SWAP_DISC, toU64Le(amountIn), toU64Le(minOut)]);
  const ixData = '0x' + data.toString('hex');

  const iface = new ethers.Interface([
    'function invoke(bytes32 program, (bytes32,bool,bool)[] accounts, bytes data)',
  ]);
  const calldata = iface.encodeFunctionData('invoke', [METEORA_PROGRAM, accounts, ixData]);

  const nonce = await provider.getTransactionCount(wallet.address, 'pending');
  const unsignedTx = {
    type: 0, chainId: CHAIN_ID, nonce, gasPrice: GAS_PRICE, gasLimit: 50_000_000n,
    to: CPI, value: 0n, data: calldata,
  };
  const signed = await wallet.signTransaction(unsignedTx);

  console.log('\n  --- rome_emulateTx ---');
  const emu = await rpc('rome_emulateTx', [signed]);
  if (emu.error) {
    console.error('  emulation FAILED:', JSON.stringify(emu.error, null, 2));
    process.exit(1);
  }
  console.log('  emulation OK');

  if (dryRun) {
    console.log('\n  DRY_RUN=1 — stopping before broadcast.');
    return;
  }

  const send = await rpc('eth_sendRawTransaction', [signed]);
  if (!send.result) {
    console.error('  sendRawTransaction failed:', JSON.stringify(send, null, 2));
    process.exit(1);
  }
  console.log('  broadcast:', send.result);

  process.stdout.write('  waiting for receipt');
  let receipt = null;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const r = await rpc('eth_getTransactionReceipt', [send.result]);
    if (r.result) { receipt = r.result; break; }
    process.stdout.write('.');
  }
  console.log('');
  if (!receipt || receipt.status !== '0x1') {
    console.error('  SWAP FAILED: status =', receipt?.status);
    if (receipt) console.error(JSON.stringify(receipt, null, 2));
    process.exit(1);
  }
  console.log('  ✓ SWAP LANDED  tx=' + send.result);
  console.log('  block=' + receipt.blockNumber, 'gas=' + parseInt(receipt.gasUsed, 16).toLocaleString());

  // Compare pool reserves before/after to confirm the swap actually
  // moved tokens.
  const conn = new Connection(SOL_RPC, 'confirmed');
  const aTokenAfter = await conn.getTokenAccountBalance(bytes32ToPublicKey(POOL.aTokenVault));
  const bTokenAfter = await conn.getTokenAccountBalance(bytes32ToPublicKey(POOL.bTokenVault));
  console.log('');
  console.log('  token A vault USDC reserve (after):', aTokenAfter.value.uiAmount);
  console.log('  token B vault WSOL reserve (after):', bTokenAfter.value.uiAmount);
}

main().catch((e) => { console.error('ERROR', e); process.exit(1); });
