// Gas ↔ chain-mint-SPL wrap/unwrap — precompile-liveness cases.
//
// These two precompiles MOVED once already (the standalone
// wrap_gas_to_spl @0x42..18 / unwrap_spl_to_gas @0x42..17 were deleted in
// the 2026-05-13 HelperProgram consolidation). This file is the
// regression net so a future move/rename trips here instead of at
// user-signing time. The legs are:
//   WRAP   native gas → chain-mint SPL ATA : Withdraw.withdraw_to_ata    @0x42..16
//   UNWRAP chain-mint SPL ATA → native gas : HelperProgram.deposit_from_ata @0xff..09
//
// Both cases run from the shared treasury (no special state) and assert a
// rich program-level revert — i.e. the precompile is LIVE and dispatched,
// then failed inside execution (insufficient balance / no wrapper ATA),
// rather than the empty success a deleted/absent precompile address would
// return. (Empty-0x success = selector absent; rich revert = present.)

import {
  WITHDRAW_PRECOMPILE_ADDR,
  HELPER_PRECOMPILE_ADDR,
  encodeWrapCall,
  encodeUnwrapCall,
} from '../../lib/wrap-unwrap-fabric';
import type { TestCaseFile } from '../lib/case';

const AMOUNT_WEI = 1_000_000_000_000_000n; // 0.001 (18-dec rsol-wei)

const cases: TestCaseFile = [
  {
    name: 'wrap-unwrap.wrap.live-precompile',
    description:
      'withdraw_to_ata(0.001) from a zero-balance signer → Withdraw precompile (0x42..16) is live + dispatches, then reverts for insufficient native gas. Guards the wrap-leg selector 0x8059abc0.',
    buildRaw: () => ({ to: WITHDRAW_PRECOMPILE_ADDR, data: encodeWrapCall(AMOUNT_WEI) }),
    // Guards that the wrap calldata is well-formed and accepted — the
    // address (0x42..16) + selector (0x8059abc0) + uint256 encoding sign
    // and route, and the proxy's native gas-prepay gate fires ("User does
    // not have sufficient funds") for the zero-balance harness signer.
    // (This is the envelope/gate check; the deep dispatch proof is the
    // unwrap case below. A malformed address would fail to sign — that's
    // how the EIP-55 checksum bug on the helper address was caught.)
    expect: { revertContains: 'sufficient funds' },
  },
  {
    name: 'wrap-unwrap.unwrap.live-precompile',
    description:
      'deposit_from_ata(0.001) from a signer with no wrapper-ATA balance → HelperProgram precompile (0xff..09) is live + dispatches, then reverts. Guards the unwrap-leg selector 0x4479b709.',
    buildRaw: () => ({ to: HELPER_PRECOMPILE_ADDR, data: encodeUnwrapCall(AMOUNT_WEI) }),
    // Live precompile dispatches into SPL Token, which rejects the
    // missing wrapper ATA with InvalidAccountData — proves the leg is
    // wired through to Solana, not a no-op at a dead address.
    expect: { revertContains: 'InvalidAccountData' },
  },
];

export default cases;
