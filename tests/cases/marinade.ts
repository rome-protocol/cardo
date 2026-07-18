// Marinade `deposit` — unhappy-path cases.
//
// Marinade's `deposit` expects:
//   - mint_to slot to be the user's mSOL ATA, owned by the user's Rome PDA,
//     with the live `state.msol_mint` as its mint.
//   - transfer_from slot to be the user's PDA (signer + writable), with
//     enough lamports.
//
// On a fresh user with no on-chain state, the user's mSOL ATA does not
// exist on Solana — Rome's strict-mode loader catches that with
// `account not found` before the Marinade program runs. That's the
// primary unhappy-path case.

import { buildMarinadeDepositInvoke } from '../../lib/marinade-instructions';
import { pubkeyBs58ToBytes32 } from '../../lib/solana-pda';
import type { TestCaseFile } from '../lib/case';

const FRESH_USER_EVM = '0x000000000000000000000000000000000000d017' as const;

// Live values verified on Solana devnet 2026-04-25 (decoding the
// State account at 8szGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC).
const MSOL_MINT_HEX = pubkeyBs58ToBytes32(
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
);
const MSOL_LEG_HEX = pubkeyBs58ToBytes32(
  '7GgPYjS5Dza89wV6FpZ23kUJRG5vbQ1GM25ezspYFSoE',
);

// A System-Program-shaped fake msol_mint. The account exists (Rome
// strict-mode passes existence) but isn't an SPL Mint, so the program
// either fails with `has_one = msol_mint` or with deserialize when
// loading the state. In practice the user's ATA derived against a
// non-mint pubkey doesn't exist either, so the strict-mode loader
// catches that first.
const FAKE_MINT_HEX = pubkeyBs58ToBytes32('11111111111111111111111111111111');

const cases: TestCaseFile = [
  {
    name: 'marinade.deposit.fresh-user-no-msol-ata',
    description:
      'Marinade deposit from a fresh user → user mSOL ATA does not exist → Rome strict-mode loader rejects with `account not found`.',
    build: () =>
      buildMarinadeDepositInvoke({
        userEvmAddress: FRESH_USER_EVM,
        msolMint: MSOL_MINT_HEX,
        msolLeg: MSOL_LEG_HEX,
        lamports: 1_000_000n, // 0.001 SOL
      }),
    expect: {
      // The mSOL ATA is one of the writable accounts the deposit ix
      // touches; on a fresh PDA it doesn't exist, so the strict-mode
      // loader catches it before the Marinade program runs. If
      // loader behavior loosens, expect Anchor's `has_one`
      // constraint or `token::mint` constraint to fail next, both
      // of which surface as `Custom(...)`.
      revertContains: 'Custom',
    },
  },
  {
    name: 'marinade.deposit.fake-msol-mint',
    description:
      'Pass System Program in place of state.msol_mint → either Anchor `has_one = msol_mint` rejects, or strict-mode catches the missing fake-derived ATA first.',
    build: () =>
      buildMarinadeDepositInvoke({
        userEvmAddress: FRESH_USER_EVM,
        msolMint: FAKE_MINT_HEX,
        msolLeg: MSOL_LEG_HEX,
        lamports: 1_000_000n,
      }),
    expect: {
      revertContains: 'Custom',
    },
  },
];

export default cases;
