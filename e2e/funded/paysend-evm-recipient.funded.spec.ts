// L4 funded — /send + /pay accept an EVM 0x recipient (another cardo user):
// the UI resolves it to that user's Rome PDA on the active chain, shows where
// it routes, and the tx lands on Solana. Fresh EVM recipient each run → the
// PDA's ATA never exists → /send exercises the full 2-sig path (operator-
// fronted create_ata_for_key, then TransferChecked); /pay needs nothing from
// the recipient (create_v2 inits their ATA inline).
//
// Regression anchor: /pay's old length-only gate let 0x… input through to a
// swallowed PublicKey throw — "Start stream" silently did nothing. The
// on-screen "routes to their Rome account" hint asserted here is the proof
// the resolver ran (not just that some tx landed).
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './lib/fixtures';
import { landFundedTx } from './lib/flow';

const EVM_RECIPIENT =
  process.env.E2E_PAYSEND_EVM_RECIPIENT ??
  privateKeyToAccount(generatePrivateKey()).address;
const SEND_AMOUNT = process.env.E2E_SEND_AMOUNT ?? '0.01';
const PAY_AMOUNT = process.env.E2E_PAY_AMOUNT ?? '0.5';

test('Funded — /send to an EVM 0x recipient lands (routes to their Rome PDA)', async ({ treasuryPage: p }) => {
  const hash = await landFundedTx(p, {
    route: '/send',
    fill: async (pg) => {
      await pg.locator('#send-recip').fill(EVM_RECIPIENT);
      // The resolver hint must render BEFORE submit — proves the 0x form was
      // recognized and resolved, not silently ignored.
      await expect(pg.getByText(/sends to their Rome account/i)).toBeVisible({ timeout: 10_000 });
      await pg.getByLabel('Amount').fill(SEND_AMOUNT);
    },
    skipHint: 'Treasury needs sendable wUSDC in its own ATA.',
    timeoutMs: 180_000,
  });
  console.log('SEND_EVM_RECIPIENT_LANDED', hash, 'recipient', EVM_RECIPIENT);
});

test('Funded — /pay streams to an EVM 0x recipient (was a silent dead button)', async ({ treasuryPage: p }) => {
  const hash = await landFundedTx(p, {
    route: '/pay',
    fill: async (pg) => {
      await pg.locator('#pay-recip').fill(EVM_RECIPIENT);
      await expect(pg.getByText(/streams to their Rome account/i)).toBeVisible({ timeout: 10_000 });
      await pg.getByLabel('Amount').fill(PAY_AMOUNT);
    },
    skipHint: 'Treasury needs sendable wUSDC for the stream.',
    timeoutMs: 180_000,
  });
  console.log('PAY_EVM_RECIPIENT_LANDED', hash, 'recipient', EVM_RECIPIENT);
});

test('/pay rejects garbage input visibly (no silent no-op)', async ({ treasuryPage: p }) => {
  await p.goto('/pay', { waitUntil: 'domcontentloaded' });
  // Fill-until-hint: the EnvProvider remounts the tree once /api/env lands
  // (boot→runtime chain), which wipes a fill that raced it on a remote pod.
  await expect(async () => {
    await p.locator('#pay-recip').fill('0xdeadbeef'); // wrong length
    await expect(p.getByText(/Not a valid EVM address/i)).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await expect(async () => {
    await p.locator('#pay-recip').fill('not-an-address-at-all-but-quite-long-000');
    await expect(p.getByText(/Not a valid address/i)).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
});
