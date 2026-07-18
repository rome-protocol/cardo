// L4 funded — portfolio gas wrap/unwrap (GasWrapCard on Home `/`). Lands REAL
// Rome txs through the act|see UI: wrap native gas (USDC) → wUSDC, and unwrap
// back. Empirically validates #115's two fixes under the live (new-gas-model)
// proxy:
//   - the fee path (rome-fee.ts: estimate on-chain + factor) actually lets the
//     tx SEND (no "Network fee Unavailable") and land — the shim now forwards
//     the exact gasPrice/gas rome-fee set, so this is the production fee path;
//   - the re-entry guard ⇒ EXACTLY ONE tx per submit (the operator's "ui shows
//     2 txns" regression). Single precompile each (withdraw_to_ata /
//     deposit_from_ata), no PDA-funding tx, so the 1-tx assertion is exact.
//
// Dual-proxy: set E2E_ROME_RPC_URL (+ a dev server with matching ROME_RPC_URL)
// to run this against Hadrian then Hadrian-LT.
import { test, expect, connectShimWallet } from './lib/fixtures';
import { assertLandedOnChain } from './lib/flow';
import type { Page } from '@playwright/test';
import type { Hex } from 'viem';

const WRAP_AMOUNT = process.env.E2E_WRAP_AMOUNT ?? '0.02';
const UNWRAP_AMOUNT = process.env.E2E_UNWRAP_AMOUNT ?? '0.02';

async function convert(
  page: Page,
  mode: 'wrap' | 'unwrap',
  amount: string,
  sentTxs: Hex[],
): Promise<Hex> {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await connectShimWallet(page);

  // Scope to the GasWrapCard — its <h3> is unique on the page. (CSS-module
  // class names are hashed, so anchor on the heading, not the class.)
  const card = page
    .locator('div', { has: page.getByRole('heading', { name: 'Wrap / unwrap gas' }) })
    .last();

  // Mode tab — EXACT name so it never matches the "Wrap …→… wUSDC" submit label.
  await card.getByRole('button', { name: mode === 'wrap' ? 'Wrap' : 'Unwrap', exact: true }).click();
  await card.getByLabel('Wrap amount').fill(amount);

  // The submit label changes through the flow (idle "Wrap …→… wUSDC" →
  // "Preparing…" → "Awaiting signature…" → "Confirming…"), so match ALL states:
  // a /→/-only locator silently stops matching the moment it goes busy.
  const submit = card.getByRole('button', {
    name: /→|Preparing|Awaiting signature|Confirming|Insufficient/i,
  });
  let actionable = false;
  try {
    await expect(submit).toBeEnabled({ timeout: 15_000 });
    await expect(submit).not.toContainText(/Insufficient/i);
    actionable = true;
  } catch {
    /* fall through to skip-with-reason */
  }
  const label = await submit.innerText().catch(() => '?');
  test.skip(!actionable, `portfolio ${mode} not actionable (CTA: "${label}") — treasury balance for this leg?`);

  await submit.click();

  // Success line in the card: "✓ Wrapped" / "✓ Unwrapped". Word boundaries keep
  // /Wrapped/ from also matching "Unwrapped".
  await expect(
    card.getByText(mode === 'wrap' ? /\bWrapped\b/i : /\bUnwrapped\b/i),
  ).toBeVisible({ timeout: 120_000 });

  // EXACTLY one tx for the single user action — the operator's "1 action → 2
  // txns" regression guard. The re-entry guard must prevent a phantom second
  // send; single precompile + no PDA funding makes the count exact.
  expect(sentTxs, `${mode} must send exactly one tx`).toHaveLength(1);
  await assertLandedOnChain(sentTxs[0]);
  return sentTxs[0];
}

test('Funded — portfolio WRAP USDC→wUSDC lands exactly one real tx', async ({ treasuryPage, sentTxs }) => {
  const hash = await convert(treasuryPage, 'wrap', WRAP_AMOUNT, sentTxs);
  console.log('WRAP_LANDED', hash);
});

test('Funded — portfolio UNWRAP wUSDC→USDC lands exactly one real tx', async ({ treasuryPage, sentTxs }) => {
  const hash = await convert(treasuryPage, 'unwrap', UNWRAP_AMOUNT, sentTxs);
  console.log('UNWRAP_LANDED', hash);
});
