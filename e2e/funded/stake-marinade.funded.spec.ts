// L4 funded — /stake-marinade deposits native SOL into Marinade and mints mSOL
// through the real act|see UI. Same 2-step shape as /stake (the SPL stake-pool
// route): "Create mSOL account" (setup: fund the user's Rome PDA + create the
// mSOL ATA) → "Stake" (deposit). Mirrors stake.funded.spec — only the route +
// LST differ. Serial-safe: one treasury wallet (run funded with --workers=1).
import { test, expect, connectShimWallet } from './lib/fixtures';
import { submitAndAwaitLanded, assertLandedOnChain } from './lib/flow';

const AMOUNT = process.env.E2E_STAKE_AMOUNT ?? '0.005';

// Regression lock for two fixes: (1) setup funds the PDA via
// useEnsurePdaLamports (was missing → deposit stalled); (2) the msol_mint
// _authority PDA seed is "st_mint" not "mint" (the wrong seed derived a bad PDA
// → Anchor ConstraintSeeds → deposit reverted Custom(2006)).
test('Funded — /stake-marinade deposits SOL → mSOL (2-step: setup + stake)', async ({
  treasuryPage,
}) => {
  await treasuryPage.goto('/stake-marinade', { waitUntil: 'domcontentloaded' });
  await connectShimWallet(treasuryPage);
  await treasuryPage.getByLabel('Stake amount').fill(AMOUNT);

  const cta = treasuryPage.locator('button[type="submit"]');
  await expect(cta).toBeEnabled({ timeout: 30_000 });

  // Step 1 — setup (fund PDA + create mSOL ATA) if not yet set up.
  if (/Create/i.test(await cta.innerText())) {
    await cta.click();
    await expect(cta).toContainText(/Stake/i, { timeout: 150_000 });
  }

  // Set up but PDA below the stake amount and no in-flow refund yet — skip with
  // a clear reason (matches /stake's affordance) rather than fail.
  const label = (await cta.innerText()).replace(/\s+/g, ' ').trim();
  test.skip(
    /Insufficient/i.test(label),
    `/stake-marinade set up but PDA below stake amount, no in-flow refund (CTA: "${label}").`,
  );

  // Step 2 — stake.
  await expect(cta).toContainText(/Stake/i);
  const hash = await submitAndAwaitLanded(treasuryPage, { timeoutMs: 150_000 });
  console.log('MARINADE_STAKE_LANDED', hash);
  await assertLandedOnChain(hash);
});
