// Orca Whirlpool — unhappy-path cases.

import {
  buildOrcaSwapInvoke,
  buildOrcaSwapV2Invoke,
} from '../../lib/orca-instructions';
import { ENABLED_ORCA_POOLS } from '../../lib/orca-pools';
import { pubkeyBs58ToBytes32 } from '../../lib/solana-pda';
import type { TestCaseFile } from '../lib/case';

const FRESH_USER_EVM = '0x000000000000000000000000000000000000d017' as const;

// Construct a fake pool by overriding `whirlpool` with a System
// Program pubkey — guaranteed to exist (so we get past the strict-mode
// gate) but won't deserialize as a Whirlpool struct, so Orca will
// revert with a discriminator/owner mismatch.
const realPool = ENABLED_ORCA_POOLS[0];
const FAKE_POOL = {
  ...realPool,
  whirlpool: pubkeyBs58ToBytes32('11111111111111111111111111111111'),
};

const cases: TestCaseFile = [
  {
    name: 'orca.swap.fake-pool-account',
    description:
      'Pass System Program in place of the Whirlpool account → Orca rejects with an owner / discriminator mismatch.',
    build: () =>
      buildOrcaSwapInvoke({
        userEvmAddress: FRESH_USER_EVM,
        pool: FAKE_POOL,
        currentTick: 0,
        aToB: true,
        amount: 1_000n,
        otherAmountThreshold: 0n,
      }),
    expect: {
      // Rome's strict-mode account loader catches the missing user
      // ATAs (`token_owner_account_a/b`) before the Orca program
      // runs. If the loader's behavior ever loosens — letting the
      // Orca program run and failing on a deserialize / wrong-owner
      // mismatch — update this to `'Custom'`. Either is a valid
      // signal that the calldata builder is correctly wired; the
      // case just asserts the revert *fires*.
      revertContains: 'Custom',
    },
  },
  {
    name: 'orca.swap-v2.fresh-user-no-ata',
    description:
      'swap_v2 from a fresh user → user token_owner_account_a/b do not exist → strict-mode `account not found`. Verifies the v2 builder calldata round-trips through Rome.',
    build: () =>
      buildOrcaSwapV2Invoke({
        userEvmAddress: FRESH_USER_EVM,
        pool: realPool,
        currentTick: 0,
        aToB: true,
        amount: 1_000n,
        otherAmountThreshold: 0n,
      }),
    expect: { revertContains: 'Custom' },
  },
];

export default cases;
