// TDD smoke for the Raydium CLMM swap_v2 invoke.
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
//     npx tsx scripts/smoke-raydium-clmm-swap.ts
//
// Expected outcomes (in order of "well-shaped → broken"):
//   * "0x" success — adapter calldata + accounts are wire-correct, the
//     user's PDA has WSOL ATA + USDC ATA + funds enough for a 1000-lamport
//     test swap.
//   * "Custom(<n>)" / "PriceSlippageCheck" / "TooMuchInputPaid" /
//     "InvalidTickArray" / similar program-level revert: calldata is
//     correct, problem is the inputs (slippage too tight, thin pool,
//     missing tick array). Adapter is shippable.
//   * "account not found: <ATA>": user's input or output ATA doesn't
//     exist on devnet. Need to externally pre-create with the treasury
//     keypair before the user can use this flow.
//   * Any wire-shape error (decoder rejects bytes, wrong account count,
//     etc.): adapter bug — fix before merging.

import { encodeFunctionData } from 'viem';
import { CPI_INVOKE_ABI, CPI_PRECOMPILE } from '../lib/cpi-precompile.ts';
import { buildRaydiumClmmSwapV2Invoke } from '../lib/raydium-clmm-instructions.ts';
import { ENABLED_RAYDIUM_CLMM_POOLS } from '../lib/raydium-clmm-pools.ts';
import {
  bytes32ToPublicKey,
  deriveRomeUserPda,
  deriveAta,
} from '../lib/solana-pda.ts';

const USER = (process.env.USER_EVM_ADDR ||
  '0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562') as `0x${string}`;
const RPC = process.env.ROME_RPC_URL || 'https://rome.devnet.romeprotocol.xyz/';
const SOL_RPC = 'https://api.devnet.solana.com';
const AMOUNT_IN = BigInt(process.env.AMOUNT_IN || '1000');
const MIN_OUT = BigInt(process.env.MIN_OUT || '0');
const INPUT_IS_TOKEN0 = (process.env.INPUT_IS_TOKEN0 ?? '0') === '1';

async function main() {
  const pool = ENABLED_RAYDIUM_CLMM_POOLS[0];
  if (!pool) throw new Error('no enabled CLMM pool in registry');

  console.log(`[smoke] user EVM:      ${USER}`);
  const userPda = deriveRomeUserPda(USER);
  const userPdaBs58 = bytes32ToPublicKey(userPda).toBase58();
  console.log(`[smoke] user Rome PDA: ${userPdaBs58}`);
  console.log(`[smoke] pool:          ${pool.poolBs58}`);
  console.log(`[smoke] amm_config:    ${bytes32ToPublicKey(pool.ammConfig).toBase58()}`);
  console.log(`[smoke] direction:     ${INPUT_IS_TOKEN0 ? 'token0 → token1 (WSOL → USDC)' : 'token1 → token0 (USDC → WSOL)'}`);
  console.log(`[smoke] amount_in:     ${AMOUNT_IN}`);
  console.log(`[smoke] min_out:       ${MIN_OUT}`);

  // Pre-flight ATA existence check.
  const inputMint = INPUT_IS_TOKEN0 ? pool.token0Mint : pool.token1Mint;
  const outputMint = INPUT_IS_TOKEN0 ? pool.token1Mint : pool.token0Mint;
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
      params: [[userInputAtaBs58, userOutputAtaBs58], { encoding: 'base64' }],
    }),
  });
  const j = await r.json();
  const [inAtaInfo, outAtaInfo] = j?.result?.value ?? [null, null];
  console.log(`[smoke] input ATA exists:  ${!!inAtaInfo}`);
  console.log(`[smoke] output ATA exists: ${!!outAtaInfo}`);

  // Build the invoke.
  const invoke = buildRaydiumClmmSwapV2Invoke({
    userEvmAddress: USER,
    pool,
    inputIsToken0: INPUT_IS_TOKEN0,
    amountIn: AMOUNT_IN,
    minimumAmountOut: MIN_OUT,
  });
  console.log(`[smoke] invoke accounts: ${invoke.accounts.length}`);
  console.log(`[smoke] invoke data len: ${(invoke.data.length - 2) / 2} bytes`);
  console.log(`[smoke]   bitmap_ext:   ${bytes32ToPublicKey(invoke.addresses.bitmapExtension).toBase58()}`);
  console.log(`[smoke]   tick_arrays:  ${invoke.addresses.tickArrays.map((h) => bytes32ToPublicKey(h).toBase58()).join(', ')}`);

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
    if (callJson.error.data) console.log('  data:    ', JSON.stringify(callJson.error.data));
    process.exit(1);
  } else {
    console.log('[smoke] eth_call OK');
    console.log('  result: ', callJson.result);
    process.exit(0);
  }
}

void main();
