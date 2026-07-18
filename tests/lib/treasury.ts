// Shared test treasury for the Cardo unhappy-path harness.
//
// Every test runs as the same dedicated EVM key — NOT the user's
// deployer (`~/.rome-rome-deployer.key`). The treasury exists so
// devs can run the suite without risking the real wallet. Each test
// only emulates against `rome_emulateTx`, so gas isn't actually spent
// — but the proxy still validates the tx envelope (chainId, nonce,
// signature, gas pricing) and rejects at the EVM layer before the
// CPI runs if the signer is unfunded.
//
// File path: ~/.cardo-test-treasury.key
//   - 64 hex chars (with or without 0x prefix), single line
//   - chmod 600
//
// Funding: ≈0.05 mETH on Rome (chainId 200010) is plenty. The
// treasury never runs writes, only emulations, but Rome still
// enforces gas-price * gas-limit ≤ balance during emulation. Refill
// via the rome-apps cli `deposit` flow.
//
// First-run UX: if the file is missing, we print a clear error +
// generate a fresh key for the dev to fund.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { createPublicClient, defineChain, http } from 'viem';
import { CHAIN_ID, RPC_URL } from './emulate';

// Local lightweight chain definition — mirrors `lib/wagmi.ts:rome`
// without pulling RainbowKit/Reown into the test runner.
const rome = defineChain({
  id: CHAIN_ID,
  name: 'Rome chain',
  nativeCurrency: { name: 'Rome ETH-equiv', symbol: 'mETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

/// Default treasury location. Override with env CARDO_TREASURY_KEY_PATH
/// for CI / one-off runs that want a different file.
export const TREASURY_PATH =
  process.env.CARDO_TREASURY_KEY_PATH ??
  path.join(os.homedir(), '.cardo-test-treasury.key');

/// Minimum balance the treasury must carry. Emulation never spends
/// gas, but the proxy validates `gas_price * gas_limit ≤ balance`
/// during signature verification, so a few hundredths of a mETH is
/// the safe floor.
export const MIN_TREASURY_BALANCE_WEI = 5_000_000_000_000_000n; // 0.005 mETH

/// Load the treasury private key from disk, or print a setup hint and
/// exit if missing. We never auto-write the file — the dev must
/// confirm by funding it.
export function loadTreasuryKey(): `0x${string}` {
  if (!fs.existsSync(TREASURY_PATH)) {
    const fresh = generatePrivateKey();
    const account = privateKeyToAccount(fresh);
    console.error(
      [
        `[cardo-tests] no treasury key at ${TREASURY_PATH}`,
        '',
        'Generate one + fund it:',
        `  echo '${fresh}' > ${TREASURY_PATH} && chmod 600 ${TREASURY_PATH}`,
        `  # then send ≥ 0.005 mETH to ${account.address} on Rome (chainId 200010)`,
        '',
        'Then re-run: npx tsx tests/runner.ts',
      ].join('\n'),
    );
    process.exit(2);
  }
  const raw = fs.readFileSync(TREASURY_PATH, 'utf8').trim();
  const pk = (raw.startsWith('0x') ? raw : `0x${raw}`) as `0x${string}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    console.error(`[cardo-tests] malformed key in ${TREASURY_PATH} (need 64 hex chars)`);
    process.exit(2);
  }
  return pk;
}

/// Print a warning if the treasury balance looks low. We don't hard-
/// fail because Rome's emulator currently runs `rome_emulateTx` for
/// reverting txs without enforcing the gas-prepay check — i.e. an
/// unfunded signer still gets back `account not found` reverts cleanly.
/// If a future proxy version tightens this, flip the warning to a
/// `throw` and this whole harness will halt with a clear message.
export async function assertTreasuryFunded(account: ReturnType<typeof privateKeyToAccount>) {
  const pub = createPublicClient({ chain: rome, transport: http() });
  const balance = await pub.getBalance({ address: account.address }).catch(() => 0n);
  if (balance < MIN_TREASURY_BALANCE_WEI) {
    console.warn(
      [
        `[cardo-tests] WARN: treasury ${account.address} balance ${balance} wei < ${MIN_TREASURY_BALANCE_WEI} wei`,
        `              emulation tolerates this today; if you start seeing transport errors,`,
        `              fund via:  rome-apps cli deposit --to ${account.address} (Rome chainId 200010)`,
      ].join('\n'),
    );
  }
}

/// Convenience: load + return the viem account, with a balance check.
export async function getTreasuryAccount() {
  const pk = loadTreasuryKey();
  const account = privateKeyToAccount(pk);
  await assertTreasuryFunded(account);
  return { account, pk };
}
