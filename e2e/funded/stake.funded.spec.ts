// L4 funded — /stake deposits native SOL into a stake pool (bSOL devnet) and
// mints the LST through the real act|see UI. A genuinely 2-step route:
//   1. "Create bSOL account" (onSetup) — funds the user's Rome PDA via
//      swap_gas_to_lamports (so the ATA-create rent + the staked SOL are
//      covered) then creates the stake-token ATA.
//   2. "Stake" (onDeposit) — deposit_sol once the funded balance lets the CTA
//      enable.
// Reuses useEnsurePdaLamports (the same generic helper /pay uses) — proves it
// generalizes to a second route. On-chain path validated separately
// (fund→create-ATA→deposit_sol all land on Hadrian, pool cranked-current).
import { test, expect, connectShimWallet } from './lib/fixtures';
import { submitAndAwaitLanded, assertLandedOnChain } from './lib/flow';

const AMOUNT = process.env.E2E_STAKE_AMOUNT ?? '0.005';

test('Funded — /stake deposits SOL → bSOL (2-step: setup + stake)', async ({ treasuryPage }) => {
  await treasuryPage.goto('/stake', { waitUntil: 'domcontentloaded' });
  await connectShimWallet(treasuryPage);
  await treasuryPage.getByLabel('Stake amount').fill(AMOUNT);

  const cta = treasuryPage.locator('button[type="submit"]');
  await expect(cta).toBeEnabled({ timeout: 30_000 });

  // Step 1 — setup (create bSOL ATA + fund PDA) if the account isn't set up.
  if (/Create/i.test(await cta.innerText())) {
    await cta.click();
    // Funding + ATA-create land, then the screen re-polls ATA-exists + PDA
    // balance and the CTA flips to "Stake". Generous window for both txs + polls.
    await expect(cta).toContainText(/Stake/i, { timeout: 150_000 });
  }

  // If we're set up but the PDA is drained below the stake amount, there's no
  // in-flow refund path yet (tracked follow-up) — skip with a clear reason
  // rather than fail.
  const label = (await cta.innerText()).replace(/\s+/g, ' ').trim();
  test.skip(
    /Insufficient/i.test(label),
    `/stake set up but PDA below stake amount and no in-flow refund (CTA: "${label}"). Follow-up: refund affordance.`,
  );

  // Step 2 — stake.
  await expect(cta).toContainText(/Stake/i);
  const hash = await submitAndAwaitLanded(treasuryPage, { timeoutMs: 150_000 });
  console.log('STAKE_LANDED', hash);
  await assertLandedOnChain(hash);
});
