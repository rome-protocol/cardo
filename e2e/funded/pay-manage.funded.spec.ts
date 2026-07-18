// L4 funded — a stream opened in the Create tab must show up in the Manage tab's
// "Your streams" list (so the user manages it in-UI, never pasting a PDA looked
// up on Solana). Creates a REAL stream, then asserts it's listed + selectable.
import { Keypair } from '@solana/web3.js';
import { test, expect } from './lib/fixtures';
import { landFundedTx } from './lib/flow';

const RECIPIENT = process.env.E2E_PAY_RECIPIENT ?? Keypair.generate().publicKey.toBase58();
const AMOUNT = process.env.E2E_PAY_AMOUNT ?? '0.5';

test('Funded — a created stream appears in Manage › Your streams', async ({ treasuryPage: p }) => {
  // 1. Open a real stream via the Create tab (reuses the proven landing flow).
  const hash = await landFundedTx(p, {
    route: '/pay',
    fill: async (pg) => {
      await pg.locator('#pay-recip').fill(RECIPIENT);
      await pg.getByLabel('Amount').fill(AMOUNT);
    },
    skipHint: 'Treasury needs sendable wUSDC for the stream.',
    timeoutMs: 180_000,
  });
  console.log('PAY_MANAGE_CREATED', hash);

  // 2. Switch to Manage — the just-created stream should be listed (recorded on
  //    create success), not require pasting anything.
  await p.getByRole('button', { name: /^Manage$/ }).first().click();

  // The row shows the amount + token; assert "Your streams" now has an entry.
  await expect(p.getByText(/Your streams/i)).toBeVisible({ timeout: 10_000 });
  await expect(p.getByText(new RegExp(`${AMOUNT}\\s*wUSDC`, 'i')).first()).toBeVisible({ timeout: 10_000 });

  // 3. Selecting it arms the Manage actions (the "Managing <pda>" hint appears).
  await p.getByText(new RegExp(`${AMOUNT}\\s*wUSDC`, 'i')).first().click();
  await expect(p.getByText(/Managing/i)).toBeVisible({ timeout: 5_000 });
});
