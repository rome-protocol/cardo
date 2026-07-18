// A MetaMask "Reject" must read as "Transaction cancelled" — never "Reverted".
// Live-wallet (treasury shim) so the CTA enables on real balances; the shim is
// then armed to reject eth_sendTransaction at click time, so no tx lands — we're
// asserting the UX of a user cancellation, not a settlement.

import { test, expect, connectShimWallet } from './lib/fixtures';

test('rejecting the wallet signature shows "Transaction cancelled", not a revert', async ({
  treasuryPage: page,
  txControl,
}) => {
  await page.goto('/swap', { waitUntil: 'domcontentloaded' });
  await connectShimWallet(page);

  // A pay amount within the treasury's balance so the CTA becomes actionable.
  await page.getByLabel('Pay amount').fill('0.01');

  const cta = page.locator('button[type="submit"]');
  await expect(cta).toBeEnabled({ timeout: 25_000 });
  const label = (await cta.innerText()).replace(/\s+/g, ' ').trim();
  test.skip(
    /Insufficient|Loading|No liquidity|Connect wallet/i.test(label),
    `swap CTA not actionable ("${label}") — treasury likely unfunded for swap on this proxy`,
  );

  // Arm the reject, then submit — the shim throws 4001 (user clicked Reject).
  txControl.rejectSends = true;
  await cta.click();

  // The status line must read cancelled (neutral), and must NOT say "Reverted".
  await expect(page.getByText(/Transaction cancelled/i)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/Reverted/i)).toHaveCount(0);
});
