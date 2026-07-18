// TDD smoke for the Raydium AMM v4 swap_base_in invoke.
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
//     npx tsx scripts/smoke-raydium-amm-swap.ts
//
// Expected outcomes:
//   * "0x" success return data — adapter shippable, AMM accepted the swap.
//   * AMM v4 program error (e.g. ExceededSlippage, InvalidStatus) — the
//     calldata is wire-correct, just bad inputs.
//   * "account not found: <X>" — calldata bug; debug what's missing.
//   * Mollusk error — potentially a Drift-style blocker; report and stop.

import { encodeFunctionData } from 'viem';
import { CPI_INVOKE_ABI, CPI_PRECOMPILE } from '../lib/cpi-precompile';
import { buildRaydiumAmmV4SwapBaseInInvoke } from '../lib/raydium-amm-instructions';
import { ENABLED_RAYDIUM_AMM_V4_POOLS } from '../lib/raydium-amm-pools';
import {
  bytes32ToPublicKey,
  deriveRomeUserPda,
  deriveAta,
} from '../lib/solana-pda';

const USER =
  process.env.USER_EVM_ADDR ||
  '0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562';
const RPC = process.env.ROME_RPC_URL || 'https://rome.devnet.romeprotocol.xyz/';
const SOL_RPC = 'https://api.devnet.solana.com';

// Default: swap 0.001 USDC (the seeded pool's coin side has 6 dp; a
// thousand units = 0.001 USDC). Tiny amount keeps slippage at zero on
// pool with 30 USDC + 38 SOL effective reserves.
const AMOUNT_IN = BigInt(process.env.AMOUNT_IN || '1000');
const INPUT_IS_COIN = (process.env.INPUT_IS_COIN ?? 'true') === 'true';
const MIN_OUT = BigInt(process.env.MIN_OUT || '1');

async function main() {
  const pool = ENABLED_RAYDIUM_AMM_V4_POOLS[0];
  if (!pool) {
    console.error('[smoke] no enabled AMM v4 pool in registry');
    process.exit(2);
  }

  console.log(`[smoke] user EVM:       ${USER}`);
  const userPda = deriveRomeUserPda(USER);
  const userPdaBs58 = bytes32ToPublicKey(userPda).toBase58();
  console.log(`[smoke] user Rome PDA:  ${userPdaBs58}`);
  console.log(`[smoke] pool:           ${pool.poolBs58}`);
  console.log(`[smoke] direction:      ${INPUT_IS_COIN ? 'coin → pc' : 'pc → coin'}`);
  console.log(`[smoke] amount_in:      ${AMOUNT_IN}`);
  console.log(`[smoke] minimum_out:    ${MIN_OUT}`);

  const inputMint = INPUT_IS_COIN ? pool.coinMint : pool.pcMint;
  const outputMint = INPUT_IS_COIN ? pool.pcMint : pool.coinMint;
  const userInputAta = deriveAta(userPda, inputMint);
  const userOutputAta = deriveAta(userPda, outputMint);
  const userInputAtaBs58 = bytes32ToPublicKey(userInputAta).toBase58();
  const userOutputAtaBs58 = bytes32ToPublicKey(userOutputAta).toBase58();
  console.log(`[smoke] user source ATA:    ${userInputAtaBs58}`);
  console.log(`[smoke] user dest   ATA:    ${userOutputAtaBs58}`);

  // Pre-flight: do the user's ATAs already exist on devnet?
  const r = await fetch(SOL_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getMultipleAccounts',
      params: [
        [userInputAtaBs58, userOutputAtaBs58],
        { encoding: 'jsonParsed' },
      ],
    }),
  });
  const j = await r.json();
  const vs = j?.result?.value || [];
  const inExists = !!vs[0];
  const outExists = !!vs[1];
  const inAmt: string | undefined = vs[0]?.data?.parsed?.info?.tokenAmount?.amount;
  const outAmt: string | undefined = vs[1]?.data?.parsed?.info?.tokenAmount?.amount;
  console.log(`[smoke] source ATA exists: ${inExists}${inAmt ? ` (balance ${inAmt})` : ''}`);
  console.log(`[smoke] dest   ATA exists: ${outExists}${outAmt ? ` (balance ${outAmt})` : ''}`);
  if (!inExists || !outExists) {
    console.warn('[smoke] note: missing ATA — Rome strict-mode loader will reject before program runs');
  }

  const invoke = buildRaydiumAmmV4SwapBaseInInvoke({
    userEvmAddress: USER as `0x${string}`,
    pool,
    inputIsCoin: INPUT_IS_COIN,
    amountIn: AMOUNT_IN,
    minimumAmountOut: MIN_OUT,
  });

  console.log(`[smoke] account count: ${invoke.accounts.length} (expect 18)`);
  console.log(`[smoke] data bytes:    ${(invoke.data.length - 2) / 2} (expect 17)`);

  const calldata = encodeFunctionData({
    abi: CPI_INVOKE_ABI,
    functionName: 'invoke',
    args: [invoke.program, invoke.accounts, invoke.data],
  });

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
    if (callJson.error.data) {
      console.log('  data:    ', JSON.stringify(callJson.error.data));
    }
    process.exit(1);
  } else {
    console.log('[smoke] eth_call OK');
    console.log('  result: ', callJson.result);
    process.exit(0);
  }
}

void main();
