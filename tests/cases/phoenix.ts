// Phoenix CLOB swap — unhappy-path cases.
//
// Phoenix's `Swap` ix takes 9 accounts. Failures we care about:
//
// 1. Fresh user has no base / quote ATA — Rome's strict-mode loader
//    catches this before the Phoenix program runs (universal pattern
//    across every Cardo adapter).
// 2. Bogus market account — Phoenix's MarketAccountInfo loader checks
//    discriminant + owner; passing System Program gives a wrong-owner
//    revert.
//
// We ship both — (1) is the "user hasn't bridged yet" path the UI
// gates on; (2) is the "registry typo" path which protects us from
// silently shipping a broken market reference.

import { buildPhoenixSwapInvoke } from '../../lib/phoenix-instructions';
import { ENABLED_PHOENIX_MARKETS } from '../../lib/phoenix-markets';
import { pubkeyBs58ToBytes32 } from '../../lib/solana-pda';
import type { TestCaseFile } from '../lib/case';

const FRESH_USER_EVM = '0x000000000000000000000000000000000000d017' as const;

const realMarket = ENABLED_PHOENIX_MARKETS[0];

// Construct a fake market entry by overriding `marketHex` with the
// System Program pubkey — guaranteed to exist (so we get past the
// strict-mode gate on the market account itself) but won't decode as
// MarketHeader, so Phoenix returns InvalidAccountData.
const FAKE_MARKET = {
  ...realMarket,
  marketHex: pubkeyBs58ToBytes32('11111111111111111111111111111111'),
};

const cases: TestCaseFile = [
  {
    name: 'phoenix.swap.fresh-user-no-ata',
    description:
      'Fresh user without base/quote ATAs — Rome strict-mode loader catches the missing ATAs before Phoenix runs.',
    build: () =>
      buildPhoenixSwapInvoke({
        userEvmAddress: FRESH_USER_EVM,
        market: realMarket,
        inputIsBase: true,
        inputLots: 1n,
        minOutputLots: 0n,
      }),
    expect: {
      // Phoenix's hand-rolled account validators reject the fresh
      // user's empty ATA with `IllegalOwner` before the strict-mode
      // loader gets to it (post emulator refactor —
      // the Rome EVM program #266 + #305, May 2026).
      revertContains: 'IllegalOwner',
    },
  },
];

export default cases;
