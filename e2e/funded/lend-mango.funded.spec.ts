// L4 funded — /lend-mango deposits the input wrapper (wSOL) into a Mango v4
// spot bank through the real act|see UI. A genuinely 2-step route:
//   1. "Create Mango account" (onCreate) — funds the user's Rome PDA via
//      swap_gas_to_lamports (the MangoAccount allocation rent ~0.06 SOL is paid
//      by the signer PDA; a fresh PDA holds 0 → account_create reverts
//      Custom(1)), then account_create. Create-success renders no tx link, so
//      we wait for the 8s account poll to flip the CTA to "Deposit".
//   2. "Deposit" (onDeposit) — token_deposit once the account exists.
// Reuses useEnsurePdaLamports (the same generic helper /pay + /stake use) —
// proves it generalizes to a THIRD route. Needs the page fix (ensureLamports in
// onCreate), so run against a local dev build, not stale live.
import { test, expect, connectShimWallet } from './lib/fixtures';
import { submitAndAwaitLanded, assertLandedOnChain } from './lib/flow';

const AMOUNT = process.env.E2E_MANGO_AMOUNT ?? '0.001';

test('Funded — /lend-mango deposit (2-step: create account + deposit)', async ({ treasuryPage }) => {
  await treasuryPage.goto('/lend-mango', { waitUntil: 'domcontentloaded' });
  await connectShimWallet(treasuryPage);
  await treasuryPage.getByLabel('Amount', { exact: true }).fill(AMOUNT);

  const cta = treasuryPage.locator('button[type="submit"]');
  await expect(cta).toBeEnabled({ timeout: 30_000 });

  // Step 1 — create the MangoAccount (funds the PDA for rent first) if needed.
  if (/Create Mango account/i.test(await cta.innerText())) {
    await cta.click();
    // Funding tx + account_create land, then useMangoAccountState's 8s poll
    // flips accountExists and the CTA becomes "Deposit". Generous window.
    await expect(cta).toContainText(/Deposit/i, { timeout: 180_000 });
  }

  // Set up but treasury below the deposit amount → skip-with-reason, don't fail.
  const label = (await cta.innerText()).replace(/\s+/g, ' ').trim();
  test.skip(
    /Insufficient/i.test(label),
    `/lend-mango set up but treasury below deposit amount (CTA: "${label}").`,
  );

  // Step 2 — deposit.
  await expect(cta).toContainText(/Deposit/i);
  const hash = await submitAndAwaitLanded(treasuryPage, { timeoutMs: 150_000 });
  console.log('LEND_MANGO_LANDED', hash);
  await assertLandedOnChain(hash);
});
