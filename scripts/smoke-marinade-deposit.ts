// TDD smoke for the Marinade Deposit invoke.
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
//     node scripts/smoke-marinade-deposit.mjs
//
// Expected outcomes:
//   * pre-fix: "account not found: <user's mSOL ATA>" — Rome strict-mode
//     rejects the writable destination ATA because it doesn't exist yet.
//   * post-fix (after externally creating the ATA via treasury keypair):
//     either "0x" success return data OR a deeper revert (e.g. "Not
//     enough user funds" if the user's PDA doesn't hold lamports). Either
//     way, the ATA-init blocker is gone and the adapter calldata is good.

import { encodeFunctionData, type Address } from 'viem';
import { CPI_INVOKE_ABI, CPI_PRECOMPILE } from '../lib/cpi-precompile.ts';
import { buildMarinadeDepositInvoke } from '../lib/marinade-instructions.ts';
import { fetchMarinadeState } from '../lib/marinade-state.ts';
import { MARINADE_STATE_BS58 } from '../lib/marinade-program.ts';
import { deriveRomeUserPda, deriveAta, bytes32ToPublicKey } from '../lib/solana-pda.ts';

const USER: Address = (process.env.USER_EVM_ADDR ?? '0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562') as Address;
const RPC = process.env.ROME_RPC_URL || 'https://rome.devnet.romeprotocol.xyz/';
const SOL_RPC = 'https://api.devnet.solana.com';
const LAMPORTS = BigInt(process.env.LAMPORTS || '1000000'); // 0.001 SOL default

async function main() {
  console.log(`[smoke] user EVM:      ${USER}`);
  const userPda = deriveRomeUserPda(USER);
  const userPdaBs58 = bytes32ToPublicKey(userPda).toBase58();
  console.log(`[smoke] user Rome PDA: ${userPdaBs58}`);

  // Live state read.
  console.log(`[smoke] fetching Marinade State ${MARINADE_STATE_BS58}…`);
  const state = await fetchMarinadeState(SOL_RPC, MARINADE_STATE_BS58);
  console.log(`[smoke]   msol_mint:    ${bytes32ToPublicKey(state.msolMint).toBase58()}`);
  console.log(`[smoke]   msol_leg:     ${bytes32ToPublicKey(state.msolLeg).toBase58()}`);

  // Derive user's mSOL ATA — the account most likely to be missing.
  const userMsolAta = deriveAta(userPda, state.msolMint);
  const userMsolAtaBs58 = bytes32ToPublicKey(userMsolAta).toBase58();
  console.log(`[smoke] user mSOL ATA: ${userMsolAtaBs58}`);

  // Pre-flight: does the user's mSOL ATA already exist on devnet?
  const ataInfoRes = await fetch(SOL_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getAccountInfo',
      params: [userMsolAtaBs58, { encoding: 'base64' }],
    }),
  });
  const ataInfoJson = await ataInfoRes.json();
  const ataExists = !!ataInfoJson?.result?.value;
  console.log(`[smoke] mSOL ATA exists on devnet: ${ataExists}`);

  // Build the Deposit invoke.
  const invoke = buildMarinadeDepositInvoke({
    userEvmAddress: USER,
    msolMint: state.msolMint,
    msolLeg: state.msolLeg,
    lamports: LAMPORTS,
  });

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
    console.log('[smoke] ❌ eth_call ERROR');
    console.log('  code:    ', callJson.error.code);
    console.log('  message: ', callJson.error.message);
    if (callJson.error.data) console.log('  data:    ', JSON.stringify(callJson.error.data));
    process.exit(1);
  } else {
    console.log('[smoke] ✅ eth_call OK');
    console.log('  result: ', callJson.result);
    process.exit(0);
  }
}

void main();
