// L4 funded — /swap lands a REAL swap through the real act|see UI. Thin spec
// over the SAME reusable landFundedTx harness as /send — only the form-fill
// differs (proves the harness reuses across routes). Default venue/pair are
// pre-selected by the screen (Meteora DAMM v1); the treasury holds wUSDC.
// Skips with a reason if the input balance / pool can't support the swap.
import { test } from './lib/fixtures';
import { landFundedTx } from './lib/flow';

const AMOUNT = process.env.E2E_SWAP_AMOUNT ?? '0.01';

test('Funded — /swap lands a real swap', async ({ treasuryPage }) => {
  const hash = await landFundedTx(treasuryPage, {
    route: '/swap',
    fill: async (p) => {
      await p.getByLabel('Pay amount').fill(AMOUNT);
    },
    skipHint: 'Treasury needs the input wrapper balance + a liquid pool for the default pair.',
  });
  console.log('SWAP_LANDED', hash);
});
