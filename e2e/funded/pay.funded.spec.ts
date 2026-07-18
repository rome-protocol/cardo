// L4 funded — /pay opens a REAL Streamflow stream through the act|see UI.
// Thin spec over the same landFundedTx harness (3rd route — only the fill
// differs). Streamflow create_v2 is genuinely 1 signature (it inits the
// recipient's stream escrow; no recipient-ATA step). Treasury streams wUSDC.
import { Keypair } from '@solana/web3.js';
import { test } from './lib/fixtures';
import { landFundedTx } from './lib/flow';

const RECIPIENT = process.env.E2E_PAY_RECIPIENT ?? Keypair.generate().publicKey.toBase58();
// Streamflow floors amountPerPeriod = net / (duration/PERIOD_SECONDS). The
// default is 1 week at 60s periods = 10080 periods, so net must be ≥ 10080
// base units (>0.0102 wUSDC) or the screen guards (amountPerPeriod=0). 0.5
// gives clear margin.
const AMOUNT = process.env.E2E_PAY_AMOUNT ?? '0.5';

// /pay opens a real Streamflow stream end-to-end. Two cardo-side fixes make
// create_v2 land (root-caused 2026-06-28):
//   1. unique nonce per stream — the page hardcoded nonce:0, so a user's 2nd+
//      stream collided on the (sender,nonce)-derived metadata PDA.
//   2. ensure-PDA-lamports — create_v2 creates ~5 accounts; their rent is paid
//      by the sender's Rome PDA, so the flow funds it via swap_gas_to_lamports
//      (persists across txs) when low, then create_v2 runs as a single CPI.
// No multi-write-CPI stacking (avoids the CpiProhibitedInIterativeTx /
// CannotRevertCpi risk) — the funding is a separate, persisting tx.
test('Funded — /pay opens a real Streamflow stream', async ({ treasuryPage }) => {
  const hash = await landFundedTx(treasuryPage, {
    route: '/pay',
    fill: async (p) => {
      await p.locator('#pay-recip').fill(RECIPIENT);
      await p.getByLabel('Amount').fill(AMOUNT);
    },
    skipHint: 'Treasury needs sendable wUSDC for the stream.',
    timeoutMs: 180_000, // may include a one-time swap_gas_to_lamports funding tx
  });
  console.log('PAY_LANDED', hash);
});
