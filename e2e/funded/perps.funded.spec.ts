// L4 funded — /perps opens AND closes a real Jupiter Perps position through the
// REAL act|see UI, driven headlessly by the Solana wallet shim (Wallet Standard
// → treasury keypair). Proves the whole Solana-wallet lane end-to-end: connect →
// /api/perps/build → sign (shim) → /api/orchestrate/relay → confirmed. Mainnet,
// real funds — so it's a manual/gated run (not pr-validate CI), same as the EVM
// funded suite.
//
// Run against the live pod (or a local server) with a funded Solana key:
//   E2E_BASE_URL=https://cardo.devnet.romeprotocol.xyz \
//   E2E_SOLANA_KEY_FILE=<your-secrets-dir>/cardo-mainnet/orchestrator-v1.key \
//   npx playwright test e2e/funded/perps.funded.spec.ts --project=funded --workers=1
import { test, expect, connectSolanaShimWallet } from './lib/fixtures';
import { flattenAllPerps, isPerpOpen } from './lib/perp-flatten';
import type { Page } from '@playwright/test';

const SIZE_USD = process.env.E2E_PERP_SIZE ?? '11';
const BASE = process.env.E2E_BASE_URL ?? 'https://cardo.devnet.romeprotocol.xyz';

// CLOSE THE LOOP: whatever happens in the test (pass, or a failure after the
// open landed), return the wallet to flat so no run ever strands an open
// position + locked collateral. A no-op when already flat.
test.afterEach(async ({ solanaTreasuryPubkey }) => {
  const closed = await flattenAllPerps(BASE, solanaTreasuryPubkey);
  if (closed.length) console.log('TEARDOWN flattened:', closed.join(', '));
});

// Poll the /perps status line for a NEW settled request (a solscan link that
// isn't `exclude`). Returns the href, or null if the run failed (so the caller
// can retry — e.g. the keeper hasn't filled the open yet).
async function waitForSubmitted(page: Page, timeoutMs: number, exclude?: string | null): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (page.isClosed()) return null;
    if (await page.getByText(/Request submitted/i).count()) {
      const link = page.locator('a[href*="solscan.io/tx/"]').last();
      if (await link.count()) {
        const href = await link.getAttribute('href');
        if (href && href !== exclude) return href;
      }
    }
    // Failure signatures (build 422 / relay revert / cancel): the run failed.
    if (await page.getByText(/failed|reverted|Custom\(|cancelled|unavailable|nothing/i).count()) {
      return null;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}

test('Funded — /perps opens + closes a Jupiter perp via the Solana shim', async ({
  solanaTreasuryPage: page,
  solanaTreasuryPubkey,
}) => {
  test.setTimeout(300_000);
  console.log('solana treasury', solanaTreasuryPubkey);

  await page.goto('/perps', { waitUntil: 'domcontentloaded' });
  await connectSolanaShimWallet(page);

  // OPEN a small SOL short (short collateralizes USDC directly).
  await page.getByRole('button', { name: /^Short$/ }).click();
  await page.getByLabel('Size', { exact: true }).fill(SIZE_USD);
  const cta = page.locator('button[type="submit"]');
  await expect(cta).toContainText(/Short SOL/i, { timeout: 20_000 });
  await cta.click();

  const openHref = await waitForSubmitted(page, 200_000);
  expect(openHref, 'open request submitted (shim connected + signed + relayed)').toBeTruthy();
  console.log('PERP_OPEN', openHref);

  // CLOSE — switch to Close and retry until the Jupiter keeper has filled the
  // open (the close build 422s with Custom(6015) until the Position exists).
  await page.getByRole('button', { name: /^Close$/ }).click();
  let closeHref: string | null = null;
  for (let i = 0; i < 6 && !closeHref; i++) {
    const closeCta = page.locator('button[type="submit"]');
    await expect(closeCta).toContainText(/Close SOL/i, { timeout: 10_000 });
    await closeCta.click();
    closeHref = await waitForSubmitted(page, 40_000, openHref);
    if (!closeHref) {
      console.log(`close retry ${i} — keeper hasn't filled the open yet`);
      await new Promise((r) => setTimeout(r, 12_000));
    }
  }
  expect(closeHref, 'close request submitted (position filled + closed)').toBeTruthy();
  console.log('PERP_CLOSE', closeHref);

  // Close the loop: the position must actually be gone, not merely a close tx
  // that landed. The keeper needs a moment to settle the decrease; poll.
  let flat = false;
  for (let i = 0; i < 6 && !flat; i++) {
    await new Promise((r) => setTimeout(r, 8_000));
    flat = !(await isPerpOpen(BASE, solanaTreasuryPubkey, 'SOL', 'short'));
  }
  expect(flat, 'wallet returned to flat (position fully closed)').toBe(true);
});
