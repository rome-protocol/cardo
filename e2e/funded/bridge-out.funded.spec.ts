// L4 funded — outbound bridge (Rome → Sepolia) burns USDC via CCTP through the
// act|see `/bridge` UI, landing a REAL Rome burn (RomeBridgeWithdraw.burnUSDC).
// Doubles as the standing on-chain verification of the outbound path (built in
// #113, fee-fixed in #115): it exercises the exact case that showed "Network
// fee Unavailable" — burnUSDC could not be sent without explicit fee fields.
//
// Not asserting an exact tx count: the hook funds the user's Rome PDA
// (ensureLamports, for the CCTP MessageSent rent) first when low, so the burn
// may be preceded by a one-time funding tx. We verify the BURN itself lands.
//
// Dual-proxy: set E2E_ROME_RPC_URL (+ a dev server with matching ROME_RPC_URL)
// to run against Hadrian then Hadrian-LT.
import { test, expect, connectShimWallet } from './lib/fixtures';
import { submitAndAwaitLanded, assertLandedOnChain } from './lib/flow';

// Pod route min for usdc-cctp-from-rome is 1 USDC (ROUTE_SPECS minAmount) —
// the pre-quote era ran this at 0.05; the pod now rejects sub-min quotes.
const AMOUNT = process.env.E2E_BRIDGE_OUT_AMOUNT ?? '1';

test('Funded — /bridge outbound USDC burn (Rome→Sepolia · CCTP) lands a real Rome burn', async ({ treasuryPage }) => {
  const page = treasuryPage;
  await page.goto('/bridge', { waitUntil: 'domcontentloaded' });
  await connectShimWallet(page);

  // Outbound. Default asset is USDC (registry assets[0]) → CCTP, the 1-signature
  // burnUSDC path; recipient defaults to the connected wallet (a valid 0x…).
  await page.getByRole('button', { name: 'Bridge out', exact: true }).click();
  await page.getByLabel('Amount').fill(AMOUNT);

  // Guard against an asset-default change silently switching us to ETH/Wormhole.
  await expect(page.getByText(/CCTP/i).first()).toBeVisible();

  const cta = page.locator('button[type="submit"]');
  await expect(cta).toBeEnabled({ timeout: 20_000 });
  await expect(cta).toContainText(/Bridge — sign 1 transaction/i);

  // burnUSDC — the burn hash is surfaced as the "burn tx ↗" link once it
  // confirms on Rome (the proxy returns the hash only after Solana settles).
  const hash = await submitAndAwaitLanded(page, { timeoutMs: 180_000 });
  console.log('BRIDGE_OUT_BURN_LANDED', hash);
  await assertLandedOnChain(hash);
});
