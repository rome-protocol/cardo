// L3 — UI render smoke (hermetic, no wallet). Drives every primary
// act|see route and asserts it renders the shell + the "Connect wallet"
// affordance, with no failed navigation. Catches design/build regressions
// without funds. Runs against E2E_BASE_URL (default live devnet).
import { test, expect } from '@playwright/test';

// EVM/act|see routes — each shows a "Connect wallet" CTA before a wallet
// connects. (/perps is now a Solana-wallet surface, asserted separately below.)
const PRIMARY_ROUTES = [
  '/',
  '/swap',
  '/lend',
  '/stake',
  '/pay',
  '/send',
  '/compose',
];

for (const route of PRIMARY_ROUTES) {
  test(`renders ${route}`, async ({ page }) => {
    const resp = await page.goto(route, { waitUntil: 'domcontentloaded' });
    expect(resp?.ok(), `navigation to ${route} returned ${resp?.status()}`).toBe(true);

    // act|see chrome: a "Connect wallet" affordance is present on every
    // primary route (the form's primary CTA before a wallet connects).
    await expect(
      page.getByRole('button', { name: /Connect wallet/i }).first(),
    ).toBeVisible({ timeout: 15_000 });
  });
}

// /perps is a first-class Solana-wallet surface (Jupiter Perps). Assert the
// real ticket renders (no wallet needed) — guards the route mounts its Solana
// chrome + client, not a dead preview.
test('perps renders the Jupiter Perps ticket', async ({ page }) => {
  await page.goto('/perps', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText(/Jupiter Perps/i).first()).toBeVisible({ timeout: 15_000 });
});

test('compose shows the not-yet-wired banner', async ({ page }) => {
  await page.goto('/compose', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText(/not yet wired|Preview/i).first()).toBeVisible({ timeout: 15_000 });
});
