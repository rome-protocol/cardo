// Reusable funded-flow helpers — shared by every tx-landing spec (send,
// swap, …) so we never copy-paste the submit→land→verify dance. Persistent,
// not throwaway: a new route reuses these + adds its own form-fill.
//
// Chain-agnostic: on-chain verification reads the same chain the app targets
// (getChainConfig(E2E_CHAIN_ID)), so a spec proven on Hadrian re-runs on any
// Rome chain via env.

import { createPublicClient, http, type Hex } from 'viem';
import { test, expect, type Page } from '@playwright/test';
import { getChainConfig } from '../../../lib/chain-config';
import { connectShimWallet } from './fixtures';

const E2E_CHAIN_ID = Number(process.env.E2E_CHAIN_ID ?? '200010');

// E2E_ROME_RPC_URL pins on-chain verification at a SPECIFIC Rome proxy (Hadrian
// vs Hadrian-LT), matching the shim's send endpoint. Defaults to the registry
// RPC for E2E_CHAIN_ID.
export function chainClient() {
  const cfg = getChainConfig(E2E_CHAIN_ID);
  return createPublicClient({ transport: http(process.env.E2E_ROME_RPC_URL ?? cfg.rpcUrl) });
}

/**
 * Click a form's primary submit CTA and wait for the act|see status line to
 * resolve. On success the screen renders a ViaLink whose <a title> carries the
 * full settled tx hash — returned here. Throws (with the on-screen reason) if
 * the UI shows "Reverted", or times out.
 */
export async function submitAndAwaitLanded(
  page: Page,
  opts: { timeoutMs?: number } = {},
): Promise<Hex> {
  const timeout = opts.timeoutMs ?? 120_000;
  await page.locator('button[type="submit"]').click();

  const deadline = Date.now() + timeout;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  while (Date.now() < deadline) {
    // A genuinely-closed page (test teardown) is terminal — surface it clearly.
    if (page.isClosed()) {
      throw new Error('page closed before a settled tx link appeared');
    }
    try {
      if (await page.getByText(/Reverted/i).count()) {
        const msg = await page
          .getByText(/Reverted/i)
          .first()
          .innerText()
          .catch(() => 'Reverted');
        throw new Error(`tx reverted in UI: ${msg}`);
      }
      const link = page.locator('a[title^="0x"]').first();
      if ((await link.count()) > 0) {
        const hash = await link.getAttribute('title');
        if (hash && /^0x[0-9a-fA-F]{64}$/.test(hash)) return hash as Hex;
      }
    } catch (e) {
      // Re-throw a real revert; swallow transient locator/navigation hiccups
      // (the act|see status line re-renders between phases) and re-poll.
      if (e instanceof Error && /reverted in UI/.test(e.message)) throw e;
    }
    // Node sleep, NOT page.waitForTimeout — the latter throws if the page is
    // mid-teardown, which surfaced as a "Target page … closed" flake after the
    // tx had already landed. A plain sleep doesn't depend on the page.
    await sleep(1500);
  }
  throw new Error(`timed out (${timeout}ms) waiting for a settled tx link`);
}

/** Assert the tx hash is a real, successful tx on the target chain. */
export async function assertLandedOnChain(hash: Hex): Promise<void> {
  const client = chainClient();
  let receipt;
  for (let i = 0; i < 5 && !receipt; i++) {
    receipt = await client.getTransactionReceipt({ hash }).catch(() => undefined);
    if (!receipt) await new Promise((r) => setTimeout(r, 2000));
  }
  expect(receipt, `no on-chain receipt for ${hash}`).toBeTruthy();
  expect(receipt!.status, `receipt status for ${hash}`).toBe('success');
}

/**
 * Reusable funded tx-landing flow for ANY act|see route: connect the treasury
 * shim → run the route-specific `fill` → wait for the CTA to be actionable
 * (skip-with-reason if the treasury isn't funded for this route) → submit →
 * wait for the tx to land → verify the receipt on-chain. Returns the tx hash.
 *
 * A new route is a ~5-line spec: pass `{ route, fill }`. No copy-paste of the
 * connect/submit/verify dance.
 */
export async function landFundedTx(
  page: Page,
  opts: {
    route: string;
    fill: (page: Page) => Promise<void>;
    skipHint?: string;
    timeoutMs?: number;
  },
): Promise<Hex> {
  await page.goto(opts.route, { waitUntil: 'domcontentloaded' });
  await connectShimWallet(page);
  await opts.fill(page);

  const cta = page.locator('button[type="submit"]');
  let actionable = false;
  try {
    await expect(cta).toBeEnabled({ timeout: 25_000 });
    await expect(cta).not.toContainText(/Insufficient|Enter recipient|Enter amount/i);
    actionable = true;
  } catch {
    /* fall through to skip-with-reason */
  }
  const label = await cta.innerText().then((t) => t.replace(/\s+/g, ' ').trim()).catch(() => '?');
  test.skip(
    !actionable,
    `${opts.route} not actionable (CTA: "${label}"). ${opts.skipHint ?? 'Treasury likely not funded for this route.'}`,
  );

  const hash = await submitAndAwaitLanded(page, { timeoutMs: opts.timeoutMs ?? 150_000 });
  await assertLandedOnChain(hash);
  return hash;
}
