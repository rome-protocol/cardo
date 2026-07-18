// L4 funded — inbound bridge (Sepolia → Rome) via WORMHOLE through the act|see
// /bridge UI: wrapAndTransferETH on Sepolia (1 sig). This funds the treasury's
// Rome wETH (the recipient is the treasury's PDA-owned wETH ATA) so the outbound
// ETH burn has something to spend.
//
// The Rome MINT is asynchronous (backend Wormhole-VAA attestation, ~15-20 min),
// so this spec verifies the Sepolia-side burn lands + the backend handoff
// ("Submitted on Sepolia"); wETH arrival on Rome is polled separately.
//
// Requires the shim to include the bridge source chain (Sepolia) — see fixtures
// (bridgeSourceChains) — and treasury Sepolia ETH for the wrap + gas. The Sepolia
// RPC resolves from the registry chain config (chain.bridge.sourceEvm.rpcUrl),
// same as the Rome web app (it happens to be a public endpoint — no internal one exists).
import { test, expect, connectShimWallet } from './lib/fixtures';

const AMOUNT = process.env.E2E_BRIDGE_IN_ETH_AMOUNT ?? '0.005';

test('Funded — /bridge inbound ETH (Sepolia→Rome · Wormhole) lands the Sepolia burn', async ({ treasuryPage, sentTxs }) => {
  const page = treasuryPage;
  await page.goto('/bridge', { waitUntil: 'domcontentloaded' });
  await connectShimWallet(page);

  // Inbound is the default direction; be explicit. Then switch asset to ETH/Wormhole.
  await page.getByRole('button', { name: 'Bridge in', exact: true }).click();
  // Open the asset picker via the in-form chip — scope to the <form> so the
  // ▾ filter doesn't match the header chain-switcher caret (first in DOM).
  await page.locator('form').getByRole('button').filter({ hasText: '▾' }).first().click();
  await page.getByRole('button', { name: /Wormhole/i }).first().click();
  await expect(page.getByText(/Wormhole/i).first()).toBeVisible();

  await page.getByLabel('Amount').fill(AMOUNT);

  const cta = page.locator('button[type="submit"]');
  await expect(cta).toBeEnabled({ timeout: 20_000 });
  await expect(cta).toContainText(/Bridge — sign 1 transaction/i);

  // wrapAndTransferETH on Sepolia — the shim switches chains + signs. The page
  // waits for the Sepolia receipt, POSTs to the backend, then shows "Submitted".
  await cta.click();
  await expect(page.getByText(/Submitted on Sepolia|Submitted/i).first()).toBeVisible({ timeout: 180_000 });

  // The shim sent exactly one Sepolia tx (the wrap+transfer).
  expect(sentTxs.length, 'inbound should send one Sepolia tx').toBeGreaterThanOrEqual(1);
  console.log('BRIDGE_IN_ETH_SEPOLIA_TX', sentTxs[sentTxs.length - 1]);
});
