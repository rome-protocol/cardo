// DAMM v2 LP — add_liquidity / remove_liquidity unhappy-path cases.

import {
  buildDammV2AddLiquidityInvoke,
  buildDammV2RemoveLiquidityInvoke,
} from '../../lib/damm-v2-instructions';
import { ENABLED_DAMM_V2_POOLS } from '../../lib/damm-v2-pools';
import { pubkeyBs58ToBytes32 } from '../../lib/solana-pda';
import type { TestCaseFile } from '../lib/case';

const FRESH_USER_EVM = '0x000000000000000000000000000000000000d017' as const;

const POOL = ENABLED_DAMM_V2_POOLS[0];
if (!POOL) {
  throw new Error(
    'tests/cases/damm-v2-lp.ts: ENABLED_DAMM_V2_POOLS empty',
  );
}

// A "position NFT mint" pubkey that isn't real on-chain. The user
// doesn't hold it, so user_position_nft_account derives to a
// non-existent ATA → strict-mode rejects.
const PHANTOM_POSITION_NFT_MINT = pubkeyBs58ToBytes32(
  'F7bvmsZxYmqWfUz4XeCyzgDDRELfMo1QeRwqxbKzh4Yp',
);

const cases: TestCaseFile = [
  {
    name: 'damm-v2.add-liquidity.fresh-user-no-position-nft',
    description:
      'add_liquidity from fresh user → position NFT account does not exist → strict-mode `account not found`.',
    build: () =>
      buildDammV2AddLiquidityInvoke({
        userEvmAddress: FRESH_USER_EVM,
        pool: POOL,
        positionNftMintHex: PHANTOM_POSITION_NFT_MINT,
        liquidityDelta: 1_000_000n,
        tokenAAmountThreshold: 1_000n,
        tokenBAmountThreshold: 1_000n,
      }),
    expect: { revertContains: 'Custom' },
  },
  {
    name: 'damm-v2.remove-liquidity.fresh-user-no-position-nft',
    description:
      'remove_liquidity from fresh user → strict-mode `account not found`.',
    build: () =>
      buildDammV2RemoveLiquidityInvoke({
        userEvmAddress: FRESH_USER_EVM,
        pool: POOL,
        positionNftMintHex: PHANTOM_POSITION_NFT_MINT,
        liquidityDelta: null,
        tokenAAmountThreshold: 0n,
        tokenBAmountThreshold: 0n,
      }),
    expect: { revertContains: 'Custom' },
  },
];

export default cases;
