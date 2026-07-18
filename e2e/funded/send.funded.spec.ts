// L4 funded — /send lands a REAL SPL transfer through the real act|see UI.
// Thin spec over the reusable landFundedTx harness: only the form-fill is
// route-specific. Fresh recipient each run → ATA always missing → exercises
// the first-send path (create recipient ATA via create_ata_for_key, then
// transfer). Promotes /send to ✅.
import { Keypair } from '@solana/web3.js';
import { test } from './lib/fixtures';
import { landFundedTx } from './lib/flow';

const RECIPIENT = process.env.E2E_SEND_RECIPIENT ?? Keypair.generate().publicKey.toBase58();
const AMOUNT = process.env.E2E_SEND_AMOUNT ?? '0.01';

test('Funded — /send creates recipient ATA + transfer lands', async ({ treasuryPage }) => {
  const hash = await landFundedTx(treasuryPage, {
    route: '/send',
    fill: async (p) => {
      await p.locator('#send-recip').fill(RECIPIENT);
      await p.getByLabel('Amount').fill(AMOUNT);
    },
    skipHint: 'Treasury needs sendable wUSDC in its own ATA.',
  });
  console.log('SEND_LANDED', hash);
});
