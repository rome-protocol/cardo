// TDD smoke: would `initialize_user_stats` then `initialize_user`
// actually clear Rome's strict-mode preflight if Cardo's user clicked
// "set up your Drift account"?
//
// Pure eth_call — no signing, no nonce. If this returns a revert string
// like `account not found: <userStats PDA>`, Rome rejects init flows and
// any perp adapter requiring per-user accounts is blocked.
//
// If it returns `0x` success or a downstream Drift program error, Rome
// allows init flows and the only remaining problem is the existing
// /lend-drift Mollusk bug.

import { encodeFunctionData } from 'viem';
import { CPI_INVOKE_ABI, CPI_PRECOMPILE } from '../../lib/cpi-precompile';
import {
  buildInitializeUserStatsInvoke,
  buildInitializeUserInvoke,
} from '../../lib/drift-spot-instructions';
import { deriveRomeUserPda, bytes32ToPublicKey } from '../../lib/solana-pda';

const USER = (process.env.USER_EVM_ADDR ||
  '0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562') as `0x${string}`;
const RPC = process.env.ROME_RPC_URL || 'https://rome.devnet.romeprotocol.xyz/';

async function ethCall(invoke: { program: any; accounts: any; data: any }, label: string) {
  const calldata = encodeFunctionData({
    abi: CPI_INVOKE_ABI,
    functionName: 'invoke',
    args: [invoke.program, invoke.accounts, invoke.data],
  });
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ from: USER, to: CPI_PRECOMPILE, data: calldata, gas: '0x2faf080' }, 'latest'],
    }),
  });
  const j = await res.json();
  if (j.error) {
    console.log(`[${label}] ❌ revert`);
    console.log(`  msg: ${j.error.message}`);
  } else {
    console.log(`[${label}] ✅ eth_call OK — result ${j.result}`);
  }
}

async function main() {
  console.log(`user EVM:      ${USER}`);
  const userPda = deriveRomeUserPda(USER);
  console.log(`user Rome PDA: ${bytes32ToPublicKey(userPda).toBase58()}`);

  const stats = buildInitializeUserStatsInvoke({ userEvmAddress: USER });
  console.log(`\nDrift userStats PDA:  ${bytes32ToPublicKey(stats.addresses.userStats).toBase58()}`);
  await ethCall(stats, 'initialize_user_stats');

  const user = buildInitializeUserInvoke({ userEvmAddress: USER, subAccountId: 0 });
  console.log(`\nDrift user PDA:       ${bytes32ToPublicKey(user.addresses.user).toBase58()}`);
  await ethCall(user, 'initialize_user');
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
