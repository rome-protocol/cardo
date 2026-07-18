// TDD smoke for the Phoenix Swap (IOC) invoke.
//
// Doesn't sign anything — calls eth_call against Rome's CPI precompile
// with `from=USER_EVM_ADDR`. Rome auto-signs as the user's PDA via the
// precompile's msg.sender check, and Rome's emulator runs the CPI
// without ever needing a real ECDSA signature. This stamps "would the
// user's actual signed tx land?" without touching their key.
//
// Run:
//   USER_EVM_ADDR=0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562 \
//     npx tsx scripts/smoke-phoenix-swap.ts
//
// Expected outcomes (in order of "well-shaped → broken"):
//   * "0x" success — adapter calldata + accounts are wire-correct, the
//     user's PDA has WSOL ATA + USDC ATA + funds enough for the swap.
//   * Phoenix-internal program error (Custom(<n>) or
//     "ExceededInsufficientFundsLimit", "OrderTooSmall", etc.) —
//     calldata is wire-correct, just bad inputs. Adapter shippable.
//   * "account not found: <ATA>": user's input or output ATA doesn't
//     exist on devnet. Need to externally pre-create with the treasury
//     keypair before the user can use this flow.
//   * Wire-shape error (decoder rejects bytes, wrong account count):
//     adapter bug — fix before merging.

import { encodeFunctionData } from 'viem';
import { CPI_INVOKE_ABI, CPI_PRECOMPILE } from '../lib/cpi-precompile.ts';
import { buildPhoenixSwapInvoke } from '../lib/phoenix-instructions.ts';
import { ENABLED_PHOENIX_MARKETS } from '../lib/phoenix-markets.ts';
import {
  bytes32ToPublicKey,
  deriveRomeUserPda,
  deriveAta,
} from '../lib/solana-pda.ts';

const USER = (process.env.USER_EVM_ADDR ||
  '0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562') as `0x${string}`;
const RPC = process.env.ROME_RPC_URL || 'https://rome.devnet.romeprotocol.xyz/';
const SOL_RPC = 'https://api.devnet.solana.com';
// Tiny IOC: 1 base lot = 0.001 WSOL when selling base.
const INPUT_LOTS = BigInt(process.env.INPUT_LOTS || '1');
const MIN_OUTPUT_LOTS = BigInt(process.env.MIN_OUTPUT_LOTS || '0');
const INPUT_IS_BASE = (process.env.INPUT_IS_BASE ?? '1') === '1';

async function main() {
  const market = ENABLED_PHOENIX_MARKETS[0];
  if (!market) throw new Error('no enabled Phoenix market in registry');

  console.log(`[smoke] user EVM:      ${USER}`);
  const userPda = deriveRomeUserPda(USER);
  const userPdaBs58 = bytes32ToPublicKey(userPda).toBase58();
  console.log(`[smoke] user Rome PDA: ${userPdaBs58}`);
  console.log(`[smoke] market:        ${market.marketBs58}`);
  console.log(`[smoke] direction:     ${INPUT_IS_BASE ? 'base→quote (WSOL→USDC)' : 'quote→base (USDC→WSOL)'}`);
  console.log(`[smoke] input_lots:    ${INPUT_LOTS}`);
  console.log(`[smoke] min_out_lots:  ${MIN_OUTPUT_LOTS}`);

  // Pre-flight ATA existence check.
  const userBaseAta = deriveAta(userPda, market.baseMint);
  const userQuoteAta = deriveAta(userPda, market.quoteMint);
  const userBaseAtaBs58 = bytes32ToPublicKey(userBaseAta).toBase58();
  const userQuoteAtaBs58 = bytes32ToPublicKey(userQuoteAta).toBase58();
  console.log(`[smoke] user base ATA:  ${userBaseAtaBs58}`);
  console.log(`[smoke] user quote ATA: ${userQuoteAtaBs58}`);

  const r = await fetch(SOL_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getMultipleAccounts',
      params: [[userBaseAtaBs58, userQuoteAtaBs58], { encoding: 'jsonParsed' }],
    }),
  });
  const j = await r.json();
  const [baseInfo, quoteInfo] = j?.result?.value ?? [null, null];
  const baseAmt: string | undefined = baseInfo?.data?.parsed?.info?.tokenAmount?.amount;
  const quoteAmt: string | undefined = quoteInfo?.data?.parsed?.info?.tokenAmount?.amount;
  console.log(`[smoke] base ATA exists:  ${!!baseInfo}, balance: ${baseAmt ?? '0'}`);
  console.log(`[smoke] quote ATA exists: ${!!quoteInfo}, balance: ${quoteAmt ?? '0'}`);

  // Build the invoke.
  const invoke = buildPhoenixSwapInvoke({
    userEvmAddress: USER,
    market,
    inputIsBase: INPUT_IS_BASE,
    inputLots: INPUT_LOTS,
    minOutputLots: MIN_OUTPUT_LOTS,
  });
  console.log(`[smoke] invoke accounts: ${invoke.accounts.length}`);
  console.log(`[smoke] invoke data len: ${(invoke.data.length - 2) / 2} bytes`);
  console.log(`[smoke]   log_authority: ${bytes32ToPublicKey(invoke.addresses.logAuthority).toBase58()}`);
  console.log(`[smoke]   base_vault:    ${bytes32ToPublicKey(invoke.addresses.baseVault).toBase58()}`);
  console.log(`[smoke]   quote_vault:   ${bytes32ToPublicKey(invoke.addresses.quoteVault).toBase58()}`);

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
