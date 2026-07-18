// L4 funded — topup on a Cardo-created stream. Streams are now created with
// can_topup=true (they used to be born can_topup=false, which made every topup
// revert Streamflow Custom(97) — the flag is immutable on-chain). This spec
// creates a fresh stream through the real Create tab, then tops it up through
// the Manage tab, proving the full create→topup loop.
import { Keypair } from '@solana/web3.js';
import { test, expect } from './lib/fixtures';
import { landFundedTx } from './lib/flow';

const RECIPIENT = process.env.E2E_PAY_RECIPIENT ?? Keypair.generate().publicKey.toBase58();
const AMOUNT = process.env.E2E_PAY_AMOUNT ?? '0.5';
const TOPUP = process.env.E2E_PAY_TOPUP_AMOUNT ?? '0.1';

test('Funded — create stream (can_topup) then Topup lands from Manage', async ({ treasuryPage: p }) => {
  // 1. Open a real stream via the Create tab.
  const created = await landFundedTx(p, {
    route: '/pay',
    fill: async (pg) => {
      await pg.locator('#pay-recip').fill(RECIPIENT);
      await pg.getByLabel('Amount').fill(AMOUNT);
    },
    skipHint: 'Treasury needs sendable wUSDC for the stream.',
    timeoutMs: 180_000,
  });
  console.log('PAY_TOPUP_CREATED', created);

  // 2. Manage tab → pick the just-created stream (recorded on create success).
  await p.getByRole('button', { name: /^Manage$/ }).first().click();
  await p.getByText(new RegExp(`${AMOUNT}\\s*wUSDC`, 'i')).first().click();
  await expect(p.getByText(/Managing/i)).toBeVisible({ timeout: 5_000 });

  // 3. Topup — must be enabled (stream born can_topup=true) and land.
  await p.locator('#mng-topup').fill(TOPUP);
  const topupBtn = p.getByRole('button', { name: /Topup stream/i });
  await expect(topupBtn).toBeEnabled({ timeout: 5_000 });
  await topupBtn.click();
  await expect(p.getByRole('button', { name: /Topup ✓/i })).toBeVisible({ timeout: 150_000 });
});
