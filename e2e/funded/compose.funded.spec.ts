// L4 funded — /compose runs the deterministic swap→lend recipe end-to-end
// through the REAL act|see UI, proving the RECONCILE crux on-chain: swap
// USDC→wSOL, read the wSOL that actually arrived, (create the Mango account
// if missing — funding its rent first), then deposit exactly that amount to
// Mango. Each leg is its own Rome-CPI tx; the shim auto-signs each as the
// executor advances. The deposit amount is the reconciled post-swap balance,
// never a guess — that's what this spec verifies lands.
//
// Run against a LOCAL build (the deployed site still has preview-only compose):
//   E2E_BASE_URL=http://localhost:3000 \
//   E2E_TREASURY_PRIVATE_KEY_FILE=<your-treasury-key-path> \
//   npx playwright test e2e/funded/compose.funded.spec.ts --project=funded --workers=1
import { test, expect, connectShimWallet } from './lib/fixtures';
import { assertLandedOnChain } from './lib/flow';

// Small but non-dust: ~0.05 USDC → a reconcilable wSOL amount.
const AMOUNT = process.env.E2E_COMPOSE_AMOUNT ?? '0.05';

test('Funded — /compose swap→lend runs end-to-end (reconciled deposit)', async ({
  treasuryPage,
  sentTxs,
}) => {
  await treasuryPage.goto('/compose', { waitUntil: 'domcontentloaded' });
  await connectShimWallet(treasuryPage);

  // swap-lend-mango is the default (first, enabled) recipe.
  await treasuryPage.getByLabel('Amount', { exact: true }).fill(AMOUNT);

  const cta = treasuryPage.locator('button[type="submit"]');
  await expect(cta).toBeEnabled({ timeout: 30_000 });
  await expect(cta).toContainText(/Run/i);

  await cta.click();

  // The run fires N sequential txs (swap [+ cold ATA], [fund + create],
  // deposit), reconciling wSOL between the swap and the deposit. Poll for
  // EITHER outcome so a reverted leg fails in seconds with its reason, rather
  // than hanging until the 285s test timeout.
  const deadline = Date.now() + 285_000;
  let complete = false;
  while (Date.now() < deadline) {
    if (treasuryPage.isClosed()) throw new Error('page closed before compose finished');
    if (await treasuryPage.getByText(/Intent complete/i).count()) {
      complete = true;
      break;
    }
    const fail = treasuryPage.getByText(/FAILED|reverted|couldn.?t|no wSOL arrived|reserves|nothing to deposit/i);
    if (await fail.count()) {
      const msg = await fail.first().innerText().catch(() => 'failed');
      throw new Error(`compose run failed in UI: ${msg}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  expect(complete, 'compose reached "Intent complete"').toBe(true);

  // Every signed step renders a Via link (a[title="0x…"]); the last is the
  // Mango deposit. Assert it landed successfully on-chain.
  const links = treasuryPage.locator('a[title^="0x"]');
  await expect(links.first()).toBeVisible();
  const depositHash = await links.last().getAttribute('title');
  expect(depositHash, 'deposit tx hash on the last step').toMatch(/^0x[0-9a-fA-F]{64}$/);
  console.log('COMPOSE_DEPOSIT_LANDED', depositHash, 'txsSent=', sentTxs.length);
  await assertLandedOnChain(depositHash as `0x${string}`);

  // At minimum the swap + deposit hit the chain (create may be skipped when
  // the treasury already has a Mango account).
  expect(sentTxs.length, 'at least swap + deposit sent').toBeGreaterThanOrEqual(2);
});
