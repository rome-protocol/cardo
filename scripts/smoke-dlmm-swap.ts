// TDD smoke for the Meteora DLMM `swap` invoke.
//
// Doesn't sign anything — just calls eth_call against Rome's CPI
// precompile with `from=USER_EVM_ADDR`. Rome auto-signs as the user's
// PDA via the precompile's msg.sender check, and Rome's emulator runs
// the CPI without ever needing a real ECDSA signature. So this script
// gives us a stamp of "would the user's actual signed tx land?" without
// touching the user's private key.
//
// Run:
//   USER_EVM_ADDR=0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562 \
//     npx tsx scripts/smoke-dlmm-swap.ts
//
// Defaults to direction Y→X (selling WSOL for USDC) because the
// seeded pool's lower-neighbor bin array is verified to exist on-chain
// while the upper-neighbor is missing (so X→Y might revert with
// `account not found` on a multi-bin crossing).
//
// Expected outcomes (in order of "well-shaped → broken"):
//   * "0x" success — adapter calldata + accounts are wire-correct, the
//     user's PDA has both ATAs + funds enough for a tiny test swap.
//   * "Custom(<n>)" / "InsufficientLiquidity" / "MaxBinArrayCrossing" /
//     "PriceSlippageCheck" / similar program-level revert: calldata is
//     correct, problem is the inputs (slippage too tight, thin pool,
//     missing bin array). Adapter is shippable.
//   * "account not found: <ATA>": user's input or output ATA doesn't
//     exist on devnet. Need to externally pre-create with the treasury
//     keypair before the user can use this flow.
//   * Any wire-shape error (decoder rejects bytes, wrong account count,
//     etc.): adapter bug — fix before merging.

import { encodeFunctionData } from 'viem';
import { CPI_INVOKE_ABI, CPI_PRECOMPILE } from '../lib/cpi-precompile';
import { buildDlmmSwapInvoke } from '../lib/dlmm-instructions';
import { ENABLED_DLMM_POOLS } from '../lib/dlmm-pools';
import {
  bytes32ToPublicKey,
  deriveRomeUserPda,
  deriveAta,
} from '../lib/solana-pda';

const USER = (process.env.USER_EVM_ADDR ||
  '0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562') as `0x${string}`;
const RPC = process.env.ROME_RPC_URL || 'https://rome.devnet.romeprotocol.xyz/';
const SOL_RPC = 'https://api.devnet.solana.com';
const AMOUNT_IN = BigInt(process.env.AMOUNT_IN || '1000');
const MIN_OUT = BigInt(process.env.MIN_OUT || '0');
// Default Y→X (WSOL → USDC) because lower-neighbor bin array exists.
const SWAP_X_FOR_Y = (process.env.SWAP_X_FOR_Y ?? '0') === '1';

async function main() {
  const pool = ENABLED_DLMM_POOLS[0];
  if (!pool) throw new Error('no enabled DLMM pool in registry');

  console.log(`[smoke] user EVM:      ${USER}`);
  const userPda = deriveRomeUserPda(USER);
  const userPdaBs58 = bytes32ToPublicKey(userPda).toBase58();
  console.log(`[smoke] user Rome PDA: ${userPdaBs58}`);
  console.log(`[smoke] pool:          ${pool.poolBs58}`);
  console.log(
    `[smoke] direction:     ${SWAP_X_FOR_Y ? 'X→Y (USDC→WSOL)' : 'Y→X (WSOL→USDC)'}`,
  );
  console.log(`[smoke] amount_in:     ${AMOUNT_IN}`);
  console.log(`[smoke] min_out:       ${MIN_OUT}`);

  // Pre-flight ATA existence check.
  const inputMint = SWAP_X_FOR_Y ? pool.tokenXMint : pool.tokenYMint;
  const outputMint = SWAP_X_FOR_Y ? pool.tokenYMint : pool.tokenXMint;
  const userInputAta = deriveAta(userPda, inputMint);
  const userOutputAta = deriveAta(userPda, outputMint);
  const userInputAtaBs58 = bytes32ToPublicKey(userInputAta).toBase58();
  const userOutputAtaBs58 = bytes32ToPublicKey(userOutputAta).toBase58();
  console.log(`[smoke] user input ATA:  ${userInputAtaBs58}`);
  console.log(`[smoke] user output ATA: ${userOutputAtaBs58}`);

  const r = await fetch(SOL_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getMultipleAccounts',
      params: [
        [userInputAtaBs58, userOutputAtaBs58],
        { encoding: 'base64' },
      ],
    }),
  });
  const j = await r.json();
  const [inAtaInfo, outAtaInfo] = j?.result?.value ?? [null, null];
  console.log(`[smoke] input ATA exists:  ${!!inAtaInfo}`);
  console.log(`[smoke] output ATA exists: ${!!outAtaInfo}`);

  // Build the invoke.
  const invoke = buildDlmmSwapInvoke({
    userEvmAddress: USER,
    pool,
    swapXForY: SWAP_X_FOR_Y,
    amountIn: AMOUNT_IN,
    minimumAmountOut: MIN_OUT,
  });
  console.log(`[smoke] invoke accounts: ${invoke.accounts.length}`);
  console.log(`[smoke] invoke data len: ${(invoke.data.length - 2) / 2} bytes`);
  console.log(
    `[smoke]   bin_arrays:  ${invoke.addresses.binArrays.map((h) => bytes32ToPublicKey(h).toBase58()).join(', ')}`,
  );
  console.log(
    `[smoke]   oracle:      ${bytes32ToPublicKey(invoke.addresses.oracle).toBase58()}`,
  );
  console.log(
    `[smoke]   event_auth:  ${bytes32ToPublicKey(invoke.addresses.eventAuthority).toBase58()}`,
  );
  console.log(
    `[smoke]   bitmap_ext:  ${bytes32ToPublicKey(invoke.addresses.bitmapExtension).toBase58()} (program-id sentinel = absent)`,
  );

  const calldata = encodeFunctionData({
    abi: CPI_INVOKE_ABI,
    functionName: 'invoke',
    args: [invoke.program, invoke.accounts, invoke.data],
  });

  // Submit eth_call (read-only) — no signing, no nonce, no gas burn.
  const callRes = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [
        { from: USER, to: CPI_PRECOMPILE, data: calldata, gas: '0x2faf080' },
        'latest',
      ],
    }),
  });
  const callJson = await callRes.json();

  if (callJson.error) {
    console.log('[smoke] eth_call ERROR');
    console.log('  code:    ', callJson.error.code);
    console.log('  message: ', callJson.error.message);
    if (callJson.error.data)
      console.log('  data:    ', JSON.stringify(callJson.error.data));
    process.exit(1);
  } else {
    console.log('[smoke] eth_call OK');
    console.log('  result: ', callJson.result);
    process.exit(0);
  }
}

void main();
