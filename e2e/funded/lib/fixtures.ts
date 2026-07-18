// Cardo funded-e2e fixtures — chain-agnostic, persistent-treasury model.
//
// Unlike the Rome web app's ephemeral+faucet model, Cardo reuses ONE pre-funded
// treasury wallet on the target Rome chain (operator decision 2026-06-28:
// "use the existing Hadrian key; no reason for a separate payer"). It's the
// same key the integration runner uses (tests/lib/treasury.ts).
//
// Chain-agnostic like the Rome web app: the target chain comes from E2E_CHAIN_ID
// (default 200010-Hadrian) and the RPC + native symbol resolve from the
// registry via lib/chain-config — nothing chain-specific is hardcoded.
//
// Signing: a viem-injected window.ethereum shim signs with the treasury
// key (no MetaMask popup). connectShimWallet() drives the act|see
// "Connect wallet" → RainbowKit modal flow.

import { test as base, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { getChainConfig } from '../../../lib/chain-config';
import { makeShimHandler, SHIM_INIT_SCRIPT, type ShimChain, type ShimState } from './wallet-shim';
import { Keypair } from '@solana/web3.js';
import { makeSolanaShimHandler, SOLANA_SHIM_INIT_SCRIPT } from './solana-wallet-shim';

const E2E_CHAIN_ID = Number(process.env.E2E_CHAIN_ID ?? '200010');

/// The funded Solana keypair for the /perps (Jupiter Perps, mainnet) lane.
/// Defaults to the funded orchestrator hot key; override with
/// E2E_SOLANA_KEY_FILE to point at a dedicated e2e wallet.
function solanaKeyBytes(): Uint8Array {
  const path =
    process.env.E2E_SOLANA_KEY_FILE ??
    `${homedir()}/rome/.secrets/cardo-mainnet/orchestrator-v1.key`;
  return Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')));
}

// E2E_ROME_RPC_URL pins the shim (signing + RPC reads) at a SPECIFIC Rome proxy
// so the SAME funded suite can run against Hadrian then Hadrian-LT (both chain
// 200010, two proxy endpoints). Defaults to the registry RPC for E2E_CHAIN_ID.
const E2E_ROME_RPC_URL = process.env.E2E_ROME_RPC_URL;

/** Resolve the target chain from the registry — chain-agnostic. */
function targetChain(): ShimChain {
  const cfg = getChainConfig(E2E_CHAIN_ID);
  return {
    id: cfg.id,
    name: cfg.name,
    rpcUrl: E2E_ROME_RPC_URL ?? cfg.rpcUrl,
    nativeCurrency: cfg.nativeCurrency,
  };
}

/// The bridge SOURCE chain (Sepolia) so the shim can sign the inbound burn
/// (wrapAndTransferETH / approve+depositForBurn). RPC comes straight from the
/// registry chain config — `chain.bridge.sourceEvm.rpcUrl` — the SAME primary
/// source the Rome web app's resolveSepoliaRpcUrl uses (no hardcode, no test-only env).
/// Empty when the chain has no bridge configured.
function bridgeSourceChains(): ShimChain[] {
  const b = getChainConfig(E2E_CHAIN_ID).bridge;
  if (!b) return [];
  return [
    {
      id: b.sourceEvm.chainId,
      name: b.sourceEvm.name,
      rpcUrl: b.sourceEvm.rpcUrl,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    },
  ];
}

/** Load the treasury private key (same default as the integration runner). */
function treasuryKey(): Hex {
  const path =
    process.env.E2E_TREASURY_PRIVATE_KEY_FILE ??
    `${homedir()}/rome/.secrets/e2e/treasury-evm.key`;
  const raw = readFileSync(path, 'utf8').trim();
  return (raw.startsWith('0x') ? raw : `0x${raw}`) as Hex;
}

type Fixtures = {
  /** The treasury EVM address (checksummed). */
  treasuryAddress: Address;
  /** A page with window.ethereum shimmed to sign as the treasury wallet. */
  treasuryPage: import('@playwright/test').Page;
  /**
   * Hashes of every tx the shim actually SENT this test (eth_sendTransaction).
   * Lets a spec assert an exact tx count — e.g. wrap/unwrap must be exactly one
   * (guards the re-entry regression where the UI fired a phantom second tx).
   */
  sentTxs: Hex[];
  /** Test-armed control: when rejectSends=true the shim throws a 4001 on the
   *  next eth_sendTransaction — simulating the user clicking Reject in MetaMask. */
  txControl: { rejectSends: boolean };
  /** The funded Solana treasury pubkey (base58). */
  solanaTreasuryPubkey: string;
  /** A page with a headless Wallet-Standard Solana wallet that signs as the
   *  funded Solana treasury — for the /perps (Jupiter Perps, mainnet) lane. */
  solanaTreasuryPage: import('@playwright/test').Page;
};

export const test = base.extend<Fixtures>({
  treasuryAddress: async ({}, use) => {
    await use(privateKeyToAccount(treasuryKey()).address);
  },

  sentTxs: async ({}, use) => {
    await use([]);
  },

  txControl: async ({}, use) => {
    await use({ rejectSends: false });
  },

  treasuryPage: async ({ context, sentTxs, txControl }, use) => {
    const chain = targetChain();
    const state: ShimState = {
      privateKey: treasuryKey(),
      address: privateKeyToAccount(treasuryKey()).address,
      chains: [chain, ...bridgeSourceChains()],
      currentChainId: chain.id,
    };
    const dispatch = makeShimHandler(state);

    await context.exposeBinding('__romeE2ESign', async (_src, args: any) => {
      if (args?.method === 'eth_sendTransaction' && txControl.rejectSends) {
        const rej: any = new Error('User rejected the request.');
        rej.code = 4001;
        throw rej;
      }
      try {
        const res = await dispatch(args);
        // Record real sends so a spec can assert an exact tx count.
        if (args?.method === 'eth_sendTransaction' && typeof res === 'string') {
          sentTxs.push(res as Hex);
        }
        return res;
      } catch (e: any) {
        const err = new Error(e?.message ?? String(e));
        (err as any).code = e?.code ?? -32603;
        throw err;
      }
    });
    await context.addInitScript(SHIM_INIT_SCRIPT);

    const page = await context.newPage();
    await use(page);
    await page.close();
  },

  solanaTreasuryPubkey: async ({}, use) => {
    await use(Keypair.fromSecretKey(solanaKeyBytes()).publicKey.toBase58());
  },

  solanaTreasuryPage: async ({ context }, use) => {
    const dispatch = makeSolanaShimHandler({ secretKey: solanaKeyBytes() });
    await context.exposeBinding('__romeSolSign', async (_src, args: any) => {
      try {
        return await dispatch(args);
      } catch (e: any) {
        throw new Error(e?.message ?? String(e));
      }
    });
    await context.addInitScript(SOLANA_SHIM_INIT_SCRIPT);
    const page = await context.newPage();
    await use(page);
    await page.close();
  },
});

export { expect };

/**
 * Connect the shim wallet through the act|see UI: click "Connect wallet",
 * then the wallet row in the RainbowKit modal (the shim announces via
 * EIP-6963 with isMetaMask:true, so it shows up as MetaMask / a browser
 * wallet). Resolves once the provider reports a connected account.
 */
export async function connectShimWallet(
  page: import('@playwright/test').Page,
): Promise<void> {
  // RainbowKit's openConnectModal is a no-op until the wagmi connector
  // finishes hydrating — which is slow on a cold dev server (first compile).
  // Re-click "Connect wallet" until the modal renders our shim row, so this
  // works on both the pre-built live site and a cold local dev server.
  await page.waitForLoadState('networkidle').catch(() => {});
  // The shim announces via EIP-6963 as "Rome E2E Shim" (under "Installed").
  // Click that row specifically — never the "MetaMask" row (that's the
  // install/QR flow when MM isn't really present).
  const walletRow = page.getByRole('button', { name: /Rome E2E Shim/i }).first();
  for (let attempt = 0; attempt < 8; attempt++) {
    if (page.isClosed()) return; // teardown mid-connect — exit cleanly, don't throw
    if (await walletRow.isVisible().catch(() => false)) break;
    if ((await page.locator('[aria-modal="true"]').count().catch(() => 0)) === 0) {
      await page.getByRole('button', { name: /Connect wallet/i }).first().click().catch(() => {});
    }
    // Node sleep, NOT page.waitForTimeout — the latter throws "Target page …
    // closed" if the page is mid-teardown, surfacing as a confusing flake.
    await new Promise((r) => setTimeout(r, 2000));
  }
  await walletRow.waitFor({ state: 'visible', timeout: 5000 });
  await walletRow.click();

  await page.waitForFunction(
    async () => {
      const accs = await (window as any).ethereum?.request?.({ method: 'eth_accounts' });
      return Array.isArray(accs) && accs.length > 0;
    },
    null,
    { timeout: 10_000 },
  );
}

/**
 * Connect the headless Solana shim through the act|see UI: open react-ui's
 * WalletMultiButton modal and click the "Rome E2E Solana" row (registered via
 * the Wallet Standard). Resolves once the adapter reports a connected account
 * (the trigger button stops reading "Select Wallet" and shows the address).
 */
export async function connectSolanaShimWallet(
  page: import('@playwright/test').Page,
): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => {});
  const trigger = page.locator('.wallet-adapter-button-trigger').first();
  const row = page.getByRole('button', { name: /Rome E2E Solana/i }).first();
  for (let attempt = 0; attempt < 8; attempt++) {
    if (page.isClosed()) return;
    if (await row.isVisible().catch(() => false)) break;
    await trigger.click().catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
  }
  await row.waitFor({ state: 'visible', timeout: 8000 });
  await row.click();
  // Connected when the trigger button no longer reads "Select Wallet".
  await page.waitForFunction(
    () => {
      const t = document.querySelector('.wallet-adapter-button-trigger');
      return !!t && !/select wallet/i.test(t.textContent || '');
    },
    null,
    { timeout: 15_000 },
  );
}
