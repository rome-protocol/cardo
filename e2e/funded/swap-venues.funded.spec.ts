// L4 funded — every swap VENUE lands a real swap through the act|see UI, driven
// by the SAME reusable landFundedTx harness (only the route differs). Table-
// driven (swap-venues.data.ts): a new venue is one row, not a new spec file.
//
// Skips-WITH-REASON (not fails) when the treasury lacks the input wrapper or the
// venue has no liquid devnet pool for the default pair — so the suite stays
// green while surfacing the exact per-venue blocker in the skip annotation.
//
// Serial: all tests share ONE treasury wallet, so they must not run
// concurrently (same-sender nonce race). Run the funded project with
// --workers=1; the serial describe enforces it within this file regardless.
import { test } from './lib/fixtures';
import { landFundedTx } from './lib/flow';
import { SWAP_VENUES } from './swap-venues.data';

test.describe('Funded — swap venues', () => {
  test.describe.configure({ mode: 'serial' });

  for (const v of SWAP_VENUES) {
    test(`${v.route} (${v.venue}) lands a real swap`, async ({ treasuryPage }) => {
      const hash = await landFundedTx(treasuryPage, {
        route: v.route,
        fill: async (p) => {
          await p.getByLabel('Pay amount').fill(v.payAmount);
        },
        skipHint: `Treasury needs ${v.inputToken} + a liquid ${v.venue} pool for the default pair.`,
      });
      console.log(`SWAP_LANDED ${v.route} ${hash}`);
    });
  }
});
