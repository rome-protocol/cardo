// L4 funded — /lend-mango Withdraw view. Verifies the withdraw side reads the
// user's IN-MANGO deposit (parsed from the MangoAccount TokenPosition ×
// bank deposit_index), not the wallet ATA balance it used to show, and that
// the gating uses it: an over-deposit amount disables the CTA, a real amount
// lands token_withdraw.
import { test, expect, connectShimWallet } from './lib/fixtures';
import { submitAndAwaitLanded, assertLandedOnChain } from './lib/flow';

const AMOUNT = process.env.E2E_MANGO_WITHDRAW_AMOUNT ?? '0.001';

test('Funded — /lend-mango Withdraw shows the deposited amount and lands', async ({ treasuryPage }) => {
  await treasuryPage.goto('/lend-mango', { waitUntil: 'domcontentloaded' });
  await connectShimWallet(treasuryPage);

  // Wait for the MangoAccount probe to resolve, then require an account (the
  // deposit spec creates it; this spec only exercises withdraw).
  const cta = treasuryPage.locator('button[type="submit"]');
  await expect(cta).not.toContainText(/Checking/i, { timeout: 30_000 });
  test.skip(
    /Create Mango account/i.test(await cta.innerText()),
    'Treasury has no MangoAccount yet — run the lend-mango deposit spec first.',
  );

  // Switch to Withdraw mode; the balance line must show the in-Mango deposit
  // (label "deposited"), resolved to a real number, not the em-dash fallback.
  // Retried click: a click during dev-server (re)hydration is silently dropped.
  const balLine = treasuryPage.getByText(/deposited/i).first();
  await expect(async () => {
    await treasuryPage.getByRole('button', { name: /^Withdraw$/ }).first().click();
    await expect(balLine).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  await expect(balLine).not.toContainText('—', { timeout: 30_000 });

  // Over-deposit amount → CTA disabled with the "More than deposited" guard.
  await treasuryPage.getByLabel('Amount', { exact: true }).fill('999999');
  await expect(cta).toContainText(/More than deposited/i, { timeout: 15_000 });
  await expect(cta).toBeDisabled();

  // Real amount → withdraw lands.
  await treasuryPage.getByLabel('Amount', { exact: true }).fill(AMOUNT);
  await expect(cta).toContainText(/^Withdraw/i, { timeout: 15_000 });
  await expect(cta).toBeEnabled({ timeout: 15_000 });
  const hash = await submitAndAwaitLanded(treasuryPage, { timeoutMs: 150_000 });
  console.log('LEND_MANGO_WITHDRAW_LANDED', hash);
  await assertLandedOnChain(hash);
});
