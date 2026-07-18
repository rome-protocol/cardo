// L4 funded — outbound bridge (Rome → Sepolia) burns wETH via WORMHOLE through
// the act|see /bridge UI: approveBurnETH + burnETH (2 sigs on Rome). This is the
// path that previously failed with "Network fee Unavailable" — burnETH could not
// be sent until #115 wired explicit fees (rome-fee.ts) into use-outbound-wh-send.
//
// Requires treasury wETH (the 8-dec wETH wrapper). The /bridge CTA enables on
// amount+recipient alone (it does NOT pre-check the wETH balance), so we
// pre-check on-chain here and skip-with-reason when unfunded rather than let the
// burn revert. Not asserting an exact tx count: ensureLamports may add a
// one-time PDA-funding tx, and approve+burn are 2 sends.
//
// Dual-proxy: set E2E_ROME_RPC_URL (+ a dev server with matching ROME_RPC_URL).
import { test, expect, connectShimWallet } from './lib/fixtures';
import { submitAndAwaitLanded, assertLandedOnChain, chainClient } from './lib/flow';
import { getChainConfig } from '../../lib/chain-config';
import { parseAbi } from 'viem';

const AMOUNT = process.env.E2E_BRIDGE_OUT_ETH_AMOUNT ?? '0.001';
const BALANCE_OF = parseAbi(['function balanceOf(address) view returns (uint256)']);

test('Funded — /bridge outbound ETH burn (Rome→Sepolia · Wormhole) lands a real Rome burn', async ({ treasuryPage, treasuryAddress }) => {
  const page = treasuryPage;

  // Pre-check: the burn spends wETH; the CTA doesn't gate on it, so skip cleanly
  // if the treasury can't cover it (registry-driven wrapper address, not hardcoded).
  const weth = getChainConfig(Number(process.env.E2E_CHAIN_ID ?? '200010')).wrappers.wEth;
  const wethBal = await chainClient().readContract({
    address: weth,
    abi: BALANCE_OF,
    functionName: 'balanceOf',
    args: [treasuryAddress],
  });
  test.skip(wethBal === 0n, `treasury holds 0 wETH (${weth}) — fund the wETH wrapper to run the outbound ETH burn.`);

  await page.goto('/bridge', { waitUntil: 'domcontentloaded' });
  await connectShimWallet(page);

  await page.getByRole('button', { name: 'Bridge out', exact: true }).click();

  // Switch from the default USDC/CCTP (assets[0]) to ETH/Wormhole: open the asset
  // picker via the in-form chip — scope to the <form> so the ▾ filter doesn't
  // match the header chain-switcher caret (first in DOM) — then pick Wormhole.
  await page.locator('form').getByRole('button').filter({ hasText: '▾' }).first().click();
  await page.getByRole('button', { name: /Wormhole/i }).first().click();
  await expect(page.getByText(/Wormhole/i).first()).toBeVisible();

  await page.getByLabel('Amount').fill(AMOUNT);

  const cta = page.locator('button[type="submit"]');
  await expect(cta).toBeEnabled({ timeout: 20_000 });
  await expect(cta).toContainText(/Bridge — sign 2 transaction/i);

  // approveBurnETH + burnETH (2 sigs) — burn hash surfaces once it confirms on Rome.
  const hash = await submitAndAwaitLanded(page, { timeoutMs: 180_000 });
  console.log('BRIDGE_OUT_ETH_BURN_LANDED', hash);
  await assertLandedOnChain(hash);
});
