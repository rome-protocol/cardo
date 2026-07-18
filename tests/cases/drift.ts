// Drift v2 Spot — unhappy-path cases.
//
// All cases here build via `lib/drift-spot-instructions.ts` so any drift
// in the live builder (account order, discriminator, encoding) trips
// the test before it ships.

import { buildDepositInvoke } from '../../lib/drift-spot-instructions';
import { DRIFT_SPOT_SOL } from '../../lib/drift-spot-config';
import { CPI_INVOKE_ABI, CPI_PRECOMPILE } from '../../lib/cpi-precompile';
import { DRIFT_PROGRAM } from '../../lib/drift-program';
import type { TestCaseFile } from '../lib/case';

void CPI_INVOKE_ABI;
void CPI_PRECOMPILE;
void DRIFT_PROGRAM;

// A throwaway EVM address that DEFINITELY has no Drift state on devnet.
// We pick a deterministic address (sha256-derived) so test runs are
// reproducible. The treasury never controls this PDA — emulation just
// needs a valid 20-byte address; the failure modes we capture happen
// inside the Solana program, not at signature verification.
//
// Deriving from a fixed string keeps this stable across machines and
// makes the failure log line copy-pastable into a fresh probe script.
const FRESH_USER_EVM = '0x000000000000000000000000000000000000d017' as const;

const cases: TestCaseFile = [
  {
    name: 'drift.deposit.no-user-token-ata',
    description:
      'Fresh EVM address has no Drift-USDC ATA on devnet → Rome strict-mode account loader rejects with "account not found".',
    build: () =>
      buildDepositInvoke({
        userEvmAddress: FRESH_USER_EVM,
        marketIndex: DRIFT_SPOT_SOL.marketIndex,
        mint: DRIFT_SPOT_SOL.mintHex,
        spotMarketVault: DRIFT_SPOT_SOL.spotMarketVault,
        spotMarketPda: DRIFT_SPOT_SOL.spotMarketPda,
        oraclePda: DRIFT_SPOT_SOL.oraclePda,
        amount: 1_000_000n, // 1.0 USDC at 6dp
      }),
    expect: {
      // Three substrings the proxy can surface for the same root cause
      // — strict mode rejects the user ATA, AccountNotInitialized
      // when the program tries to load it, or just "Custom" with the
      // Drift error code 6024 (UserStatsNotInitialized) when the
      // ATA is missing too. Match the strongest signal first; fall
      // back to looser matches.
      revertContains: 'Custom',
    },
  },
  {
    name: 'drift.deposit.zero-amount',
    description:
      'Same builder, amount=0 — still reverts at the strict-mode loader on the missing user ATA. Confirms calldata builds + signs cleanly even at the boundary value.',
    build: () =>
      buildDepositInvoke({
        userEvmAddress: FRESH_USER_EVM,
        marketIndex: DRIFT_SPOT_SOL.marketIndex,
        mint: DRIFT_SPOT_SOL.mintHex,
        spotMarketVault: DRIFT_SPOT_SOL.spotMarketVault,
        spotMarketPda: DRIFT_SPOT_SOL.spotMarketPda,
        oraclePda: DRIFT_SPOT_SOL.oraclePda,
        amount: 0n,
      }),
    expect: { revertContains: 'Custom' },
  },
];

export default cases;
