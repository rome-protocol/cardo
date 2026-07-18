// L4 funded — /swap lands REAL swaps on the seeded LST pools (USDC→mSOL,
// USDC→wJitoSOL) through the act|see UI. Parametrized over the LST set so
// a future pool (bSOL, …) is one row here, not a new spec. Reuses the
// same landFundedTx harness as swap.funded.spec.ts; only the form-fill
// differs (pick the LST in the "You receive" token picker first).
import { test } from './lib/fixtures';
import { landFundedTx } from './lib/flow';

const AMOUNT = process.env.E2E_SWAP_LST_AMOUNT ?? '0.2';

const LST_CASES = [
  // pickerName must be regex-safe (no parens) — it's matched via RegExp.
  { sym: 'mSOL', pickerName: 'Marinade staked SOL' },
  { sym: 'wJitoSOL', pickerName: 'Rome Wrapped JitoSOL' },
];

for (const c of LST_CASES) {
  test(`Funded — /swap lands USDC→${c.sym} on the seeded LST pool`, async ({ treasuryPage }) => {
    const hash = await landFundedTx(treasuryPage, {
      route: '/swap',
      fill: async (p) => {
        // The "You receive" chip defaults to WSOL — open its picker and
        // choose the LST (row is uniquely named by the token's full name).
        await p.locator('button').filter({ hasText: '▾' }).filter({ hasText: 'WSOL' }).click();
        await p.getByPlaceholder('Search name or paste address').fill(c.sym);
        await p.getByRole('button', { name: new RegExp(c.pickerName) }).click();
        await p.getByLabel('Pay amount').fill(AMOUNT);
      },
      skipHint: `Treasury needs USDC + the seeded USDC↔${c.sym} pool live on the target chain.`,
    });
    console.log(`SWAP_LST_${c.sym}_LANDED`, hash);
  });
}
