// Real-user smoke test: /send → SPL Token Approve.
//
// Methodology (per user direction 2026-04-26): a smoke test that has
// NO privileged access. The script signs ONLY with a fresh EVM keypair
// stored at ~/.rome/.secrets/cardo-smoke/smoke-user-v1.key — generated
// for this purpose, no link to the dev treasury or operator keys.
//
// Funding (regular Rome L2 user actions):
//   1. Send ~0.005 mETH to the smoke address → gas
//   2. Bridge any USDC amount to the smoke address → creates the
//      user's USDC ATA on Solana devnet
//
// What the script proves:
//   - Rome tx submitted via `eth_sendRawTransaction` lands.
//   - Receipt status === success.
//   - Solana state changed: source USDC ATA's `delegate` field is now
//     the chosen delegate pubkey.
//
// Pick: SPL Token Approve. Cleanest first smoke — no destination ATA
// needed, just sets the source ATA's `delegate` field to a chosen
// pubkey.
//
// Exit code: 0 PASS, 1 FAIL.

import fs from 'node:fs';
import path from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  http,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Connection, PublicKey } from '@solana/web3.js';
import { CPI_INVOKE_ABI, CPI_PRECOMPILE } from '../../lib/cpi-precompile';
import { buildSplApproveCheckedInvoke } from '../../lib/spl-token-extensions';
import {
  bytes32ToPublicKey,
  deriveAta,
  deriveRomeUserPda,
  pubkeyBs58ToBytes32,
} from '../../lib/solana-pda';

const KEY_PATH =
  process.env.CARDO_SMOKE_KEY ??
  path.join(
    process.env.HOME ?? '',
    'rome/.secrets/cardo-smoke/smoke-user-v1.key',
  );

const ROME_RPC =
  process.env.ROME_RPC_URL ?? 'https://rome.devnet.romeprotocol.xyz/';
const SOLANA_RPC =
  process.env.SOLANA_DEVNET_RPC ?? 'https://api.devnet.solana.com';

const USDC_MINT_BS58 = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const USDC_DECIMALS = 6;

// Delegate pubkey: arbitrary, just needs to be a valid Solana address.
// We use the SystemProgram zero pubkey so it's deterministic.
const DELEGATE_BS58 = '11111111111111111111111111111111';

const APPROVE_AMOUNT = 100_000n; // 0.1 USDC delegated

const rome = defineChain({
  id: 999999,
  name: 'Rome chain',
  nativeCurrency: { name: 'Rome mETH', symbol: 'mETH', decimals: 18 },
  rpcUrls: { default: { http: [ROME_RPC] } },
});

async function main() {
  // ---------- Load smoke user ----------
  if (!fs.existsSync(KEY_PATH)) {
    console.error(`[smoke] missing key file: ${KEY_PATH}`);
    process.exit(1);
  }
  const pk = fs.readFileSync(KEY_PATH, 'utf8').trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    console.error('[smoke] key file does not contain a 0x-prefixed 64-hex private key');
    process.exit(1);
  }
  const account = privateKeyToAccount(pk as Hex);
  console.log('[smoke] user EVM:        ', account.address);

  const userPdaHex = deriveRomeUserPda(account.address);
  const userPdaBs58 = bytes32ToPublicKey(userPdaHex).toBase58();
  console.log('[smoke] user Solana PDA: ', userPdaBs58);

  // ---------- Rome pre-flight: gas + WUSDC presence ----------
  const publicClient = createPublicClient({ chain: rome, transport: http() });
  const ethBal = await publicClient.getBalance({ address: account.address });
  console.log(`[smoke] Rome mETH:      ${ethBal} wei`);
  if (ethBal === 0n) {
    console.error(
      `[smoke] FAIL — no mETH for gas. Send ~0.005 mETH to ${account.address} on Rome (chainId ${rome.id}).`,
    );
    process.exit(1);
  }

  // ---------- Solana pre-flight: source USDC ATA must exist ----------
  const conn = new Connection(SOLANA_RPC, 'confirmed');
  const usdcMint = new PublicKey(USDC_MINT_BS58);
  const sourceAtaHex = deriveAta(userPdaHex, pubkeyBs58ToBytes32(USDC_MINT_BS58));
  const sourceAtaBs58 = bytes32ToPublicKey(sourceAtaHex).toBase58();
  console.log('[smoke] source USDC ATA: ', sourceAtaBs58);

  const sourceInfo = await conn.getAccountInfo(new PublicKey(sourceAtaBs58));
  if (!sourceInfo) {
    console.error(
      `[smoke] FAIL — source USDC ATA does not exist on Solana devnet. The user must bridge any non-zero USDC to ${account.address} first; the bridge auto-creates the ATA owned by the Rome PDA ${userPdaBs58}. USDC mint: ${USDC_MINT_BS58}.`,
    );
    process.exit(1);
  }

  const beforeDelegate = readAtaDelegate(sourceInfo.data);
  console.log('[smoke] before: delegate =', beforeDelegate ?? '<none>');

  // ---------- Build + sign + send ----------
  const delegateHex = pubkeyBs58ToBytes32(DELEGATE_BS58);
  const invoke = buildSplApproveCheckedInvoke({
    userEvmAddress: account.address,
    mintHex: pubkeyBs58ToBytes32(USDC_MINT_BS58),
    delegateHex,
    amount: APPROVE_AMOUNT,
    decimals: USDC_DECIMALS,
  });
  const calldata = encodeFunctionData({
    abi: CPI_INVOKE_ABI,
    functionName: 'invoke',
    args: [invoke.program, invoke.accounts, invoke.data],
  });

  const walletClient = createWalletClient({
    account,
    chain: rome,
    transport: http(),
  });

  const hash = await walletClient.sendTransaction({
    to: CPI_PRECOMPILE,
    data: calldata,
    gas: 30_000_000n,
    gasPrice: 11_000_000_000n,
  });
  console.log('[smoke] EVM tx submitted: ', hash);

  // ---------- Wait for receipt ----------
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    timeout: 90_000,
  });
  console.log('[smoke] receipt status:    ', receipt.status);
  console.log('[smoke] receipt block:     ', receipt.blockNumber.toString());
  if (receipt.status !== 'success') {
    console.error('[smoke] FAIL — Rome tx reverted');
    process.exit(1);
  }

  // ---------- Verify Solana state change ----------
  // Poll for up to 30s — Hercules indexer needs a few seconds to ship
  // the CPI to Solana devnet.
  const start = Date.now();
  let afterDelegate: string | null = null;
  while (Date.now() - start < 30_000) {
    const info = await conn.getAccountInfo(new PublicKey(sourceAtaBs58));
    afterDelegate = info ? readAtaDelegate(info.data) : null;
    if (afterDelegate === DELEGATE_BS58) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log('[smoke] after:  delegate =', afterDelegate ?? '<none>');

  if (afterDelegate !== DELEGATE_BS58) {
    console.error(
      `[smoke] FAIL — source ATA delegate did not flip. expected=${DELEGATE_BS58} got=${afterDelegate}.`,
    );
    process.exit(1);
  }

  console.log('[smoke] PASS — Rome tx landed and Solana ATA delegate updated.');
  console.log('  EVM hash:          ', hash);
  console.log('  EVM block:         ', receipt.blockNumber.toString());
  console.log('  Solana ATA:        ', sourceAtaBs58);
  console.log('  Solana mint:       ', usdcMint.toBase58());
  console.log('  Delegate set to:   ', DELEGATE_BS58);
  console.log('  Approved amount:   ', APPROVE_AMOUNT.toString(), '(0.1 USDC)');
}

// SPL Token classic ATA layout (all SPL-Token mints share the same):
//   bytes 0..32   : mint
//   bytes 32..64  : owner
//   bytes 64..72  : amount (u64 le)
//   bytes 72      : delegateOption (1 byte: 0 or 1)
//   bytes 73..105 : delegate (if delegateOption == 1, else uninit)
//   ... rest unused for our purposes
function readAtaDelegate(data: Buffer): string | null {
  if (data.length < 105) return null;
  const has = data.readUInt8(72) === 1;
  if (!has) return null;
  const slice = data.subarray(73, 73 + 32);
  return new PublicKey(slice).toBase58();
}

main().catch((e) => {
  console.error('[smoke] threw:', e);
  process.exit(1);
});
