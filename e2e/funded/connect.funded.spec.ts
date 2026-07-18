// L4 funded — foundation: prove the treasury-keyed shim connects to the
// REAL act|see UI through RainbowKit. This is the precondition every
// tx-landing funded spec builds on (connect → fill → sign → land).
//
// Needs E2E_TREASURY_PRIVATE_KEY_FILE (default <your-secrets-dir>/e2e/
// treasury-evm.key) and a reachable app (E2E_BASE_URL, default live
// devnet). No token balances required — this only asserts the connect.
import { test, expect, connectShimWallet } from './lib/fixtures';

test.describe('Funded — wallet connects to the act|see UI', () => {
  test('shim connects; the Connect-wallet CTA is replaced', async ({
    treasuryPage,
    treasuryAddress,
  }) => {
    await treasuryPage.goto('/swap', { waitUntil: 'domcontentloaded' });

    // Sanity: pre-connect the CTA is present.
    await expect(
      treasuryPage.getByRole('button', { name: /Connect wallet/i }).first(),
    ).toBeVisible({ timeout: 15_000 });

    await connectShimWallet(treasuryPage);

    // Post-connect: the provider reports the treasury account...
    const accounts = await treasuryPage.evaluate(() =>
      (window as any).ethereum.request({ method: 'eth_accounts' }),
    );
    expect(accounts[0]?.toLowerCase()).toBe(treasuryAddress.toLowerCase());

    // ...and the UI reflects it (the "Connect wallet" CTA is gone).
    await expect(
      treasuryPage.getByRole('button', { name: /^Connect wallet$/i }),
    ).toHaveCount(0, { timeout: 15_000 });
  });
});
