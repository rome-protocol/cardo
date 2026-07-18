// L4 funded — /stake › Unstake burns LST (bSOL devnet) back to SOL through the
// real act|see UI. Uses plain WithdrawSol (tag 16): the devnet spl-stake-pool
// deployment predates the *WithSlippage variants (tags 22-25 → BorshIoError at
// dispatch — the exact revert users hit before this spec existed). Regression
// guard for that: if this lands, the tag-16 path works end to end.
import { test, expect, connectShimWallet } from './lib/fixtures';
import { submitAndAwaitLanded, assertLandedOnChain } from './lib/flow';

const AMOUNT = process.env.E2E_UNSTAKE_AMOUNT ?? '0.001';

test('Funded — /stake Unstake burns bSOL → SOL via WithdrawSol', async ({ treasuryPage }) => {
  await treasuryPage.goto('/stake', { waitUntil: 'domcontentloaded' });
  await connectShimWallet(treasuryPage);

  // Switch to the Unstake tab (its own act|see rig). Retried click: a click
  // during dev-server (re)hydration is silently dropped, so click until the
  // unstake panel actually renders.
  await expect(async () => {
    await treasuryPage.getByRole('button', { name: /^Unstake$/ }).first().click();
    await expect(treasuryPage.getByLabel('Unstake amount')).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  await treasuryPage.getByLabel('Unstake amount').fill(AMOUNT);

  const cta = treasuryPage.locator('button[type="submit"]');
  await expect(cta).toBeEnabled({ timeout: 30_000 });

  const label = (await cta.innerText()).replace(/\s+/g, ' ').trim();
  test.skip(
    /Insufficient/i.test(label),
    `Treasury holds less than ${AMOUNT} bSOL — run the stake spec first (CTA: "${label}").`,
  );

  const hash = await submitAndAwaitLanded(treasuryPage, { timeoutMs: 150_000 });
  console.log('UNSTAKE_LANDED', hash);
  await assertLandedOnChain(hash);
});
