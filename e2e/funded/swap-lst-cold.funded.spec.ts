// L4 funded — COLD-account /swap: a first-time wallet (no prior swap
// state) sells the mSOL it just staked back to USDC on the seeded LST
// pool. Exercises the cold path the warm treasury never hits: the
// output-token (USDC) ATA does not exist yet, so the flow must surface
// the setup step (or auto-create) before the swap can land.
//
// Point E2E_TREASURY_PRIVATE_KEY_FILE at the fresh wallet's key file —
// wallet needs gas + an mSOL balance (e.g. staked via /stake-marinade).
import { test } from './lib/fixtures';
import { landFundedTx } from './lib/flow';

const AMOUNT = process.env.E2E_SWAP_COLD_AMOUNT ?? '0.005';

test('Funded — cold wallet swaps freshly-staked mSOL → USDC', async ({ treasuryPage }) => {
  const hash = await landFundedTx(treasuryPage, {
    route: '/swap',
    fill: async (p) => {
      // From: USDC → mSOL (picker rows are named by full token name).
      await p.locator('button').filter({ hasText: '▾' }).filter({ hasText: 'USDC' }).first().click();
      await p.getByPlaceholder('Search name or paste address').fill('mSOL');
      await p.getByRole('button', { name: /Marinade staked SOL/ }).click();
      // To: WSOL → USDC.
      await p.locator('button').filter({ hasText: '▾' }).filter({ hasText: 'WSOL' }).click();
      await p.getByPlaceholder('Search name or paste address').fill('USDC');
      await p.getByRole('button', { name: /Rome Wrapped USDC/ }).click();
      await p.getByLabel('Pay amount').fill(AMOUNT);
      // Freshly-seeded pools are shallow: the client quote overstates the
      // LST→USDC output by ~2.4% vs Meteora's on-chain vault-share math
      // (usePoolReserves approximation — deep pools mask it), so tighter
      // floors trip ExceededSlippage (6004). 3% documents + absorbs it
      // until the quote path mirrors getAmountByShare exactly.
      await p.getByLabel('Custom slippage').fill('3');
    },
    skipHint: 'Needs a cold wallet holding mSOL (stake first) + the seeded USDC↔mSOL pool.',
  });
  console.log('SWAP_COLD_MSOL_TO_USDC_LANDED', hash);
});
