// L4 funded — inbound bridge (Sepolia → Rome) via CCTP through the act|see
// /bridge UI, quote-first against the LIVE bridge-api pod: the hook quotes,
// the user signs the QUOTE's [approve, depositForBurn] (2 sigs) + the EIP-712
// SettleAuthorization (gasless typed-data sig; the shim serves
// eth_signTypedData_v4), and the hook registers the transfer.
//
// The Rome credit is asynchronous (Circle attestation + sponsor receive +
// settle, standard tier ~15-20 min), so this spec asserts through the
// REGISTRATION boundary: burn landed + transfer registered + the pod's status
// (registered / awaiting attestation) rendered from GET /v1/transfers/:id.
// Requires treasury Sepolia USDC + ETH gas.
import { test, expect, connectShimWallet } from './lib/fixtures';

// Pod route min for usdc-cctp-to-rome is 1 USDC (ROUTE_SPECS minAmount).
const AMOUNT = process.env.E2E_BRIDGE_IN_USDC_AMOUNT ?? '1';

test('Funded — /bridge inbound USDC (Sepolia→Rome · CCTP) burns, signs settle auth, and registers with the pod', async ({ treasuryPage, sentTxs }) => {
  const page = treasuryPage;
  await page.goto('/bridge', { waitUntil: 'domcontentloaded' });
  await connectShimWallet(page);

  // Inbound + USDC/CCTP is the default asset (assets[0]); be explicit on direction.
  await page.getByRole('button', { name: 'Bridge in', exact: true }).click();
  await page.getByLabel('Amount').fill(AMOUNT);

  const cta = page.locator('button[type="submit"]');
  await expect(cta).toBeEnabled({ timeout: 20_000 });
  await expect(cta).toContainText(/Bridge — sign 2 transaction/i);

  // approve + depositForBurn on Sepolia (2 sigs), then the settle typed-data
  // signature, then POST /v1/transfers — all driven by the hook.
  await cta.click();
  await expect(page.getByText(/Submitted on Sepolia|Submitted/i).first()).toBeVisible({ timeout: 240_000 });

  // Registration proof: the page polls GET /v1/transfers/:id and renders the
  // pod's phase — registered / awaiting attestation / crediting. If
  // registration had failed, the page would show "tracking unavailable".
  await expect(
    page.getByText(/registered|awaiting attestation|crediting/i).first(),
  ).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/tracking unavailable/i)).toHaveCount(0);

  expect(sentTxs.length, 'inbound CCTP should send two Sepolia txs (approve + burn)').toBeGreaterThanOrEqual(2);
  console.log('BRIDGE_IN_USDC_SEPOLIA_BURN', sentTxs[sentTxs.length - 1]);
});
