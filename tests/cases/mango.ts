// Mango v4 — extension ix unhappy-path cases.

import {
  buildMangoAccountCloseInvoke,
  buildMangoAccountEditInvoke,
  buildMangoAccountExpandInvoke,
  buildMangoTcsCancelInvoke,
  buildMangoTcsCreateInvoke,
} from '../../lib/mango-instructions';
import { pubkeyBs58ToBytes32 } from '../../lib/solana-pda';
import type { TestCaseFile } from '../lib/case';

const FRESH_USER_EVM = '0x000000000000000000000000000000000000d017' as const;

// A real Mango v4 group on devnet exists at
// `78b8f4cGCwmZ9ysPFMWLaLTkkaYnUjwMJYStWe5RTSSX` (per memory
// `project_mango_realms_devnet_state.md` — 43 Mango Groups verified).
// We use it because the `group` account is readonly + checked by
// has_one constraints; a fresh user's mango_account PDA underneath
// it doesn't exist, so strict-mode rejects with `account not found`
// before account_close runs.
const MANGO_GROUP = pubkeyBs58ToBytes32(
  '78b8f4cGCwmZ9ysPFMWLaLTkkaYnUjwMJYStWe5RTSSX',
);

const cases: TestCaseFile = [
  {
    name: 'mango.account-close.fresh-user-no-account',
    description:
      'account_close from a fresh user → MangoAccount PDA does not exist → strict-mode `account not found`. Verifies account_close calldata + force_close=false encoding.',
    build: () =>
      buildMangoAccountCloseInvoke({
        userEvmAddress: FRESH_USER_EVM,
        groupHex: MANGO_GROUP,
      }),
    expect: { revertContains: 'Custom' },
  },
  {
    name: 'mango.account-edit.fresh-user-no-account',
    description:
      'account_edit from a fresh user → MangoAccount PDA does not exist → strict-mode `account not found`. Verifies account_edit calldata + Option<String>/Option<Pubkey>/Option<u64> Borsh encoding.',
    build: () =>
      buildMangoAccountEditInvoke({
        userEvmAddress: FRESH_USER_EVM,
        groupHex: MANGO_GROUP,
        name: 'cardo test',
        delegateHex: pubkeyBs58ToBytes32('11111111111111111111111111111111'),
      }),
    expect: { revertContains: 'Custom' },
  },
  {
    name: 'mango.account-expand.fresh-user-no-account',
    description:
      'account_expand from a fresh user → MangoAccount PDA does not exist → strict-mode `account not found`. Verifies account_expand calldata + 4×u8 args.',
    build: () =>
      buildMangoAccountExpandInvoke({
        userEvmAddress: FRESH_USER_EVM,
        groupHex: MANGO_GROUP,
        tokenCount: 16,
        serum3Count: 4,
        perpCount: 4,
        perpOoCount: 8,
      }),
    expect: { revertContains: 'Custom' },
  },
  {
    name: 'mango.tcs-create.fresh-user-no-account',
    description:
      'token_conditional_swap_create from a fresh user → MangoAccount PDA missing → strict-mode `account not found`. Verifies the 50-byte args body (3× u64 + 3× f64 + 2× bool).',
    build: () =>
      buildMangoTcsCreateInvoke({
        userEvmAddress: FRESH_USER_EVM,
        groupHex: MANGO_GROUP,
        // Two arbitrary bank pubkeys — won't be deserialized because
        // strict-mode rejects on the missing MangoAccount first.
        buyBankHex: pubkeyBs58ToBytes32('11111111111111111111111111111111'),
        sellBankHex: pubkeyBs58ToBytes32('11111111111111111111111111111111'),
        maxBuy: 1_000n,
        maxSell: 1_000n,
        expiryTimestamp: 0n,
        priceLowerLimit: 0.95,
        priceUpperLimit: 1.05,
        pricePremiumRate: 0.005,
        allowCreatingDeposits: true,
      }),
    expect: { revertContains: 'Custom' },
  },
  {
    name: 'mango.tcs-cancel.fresh-user-no-account',
    description:
      'token_conditional_swap_cancel from a fresh user → strict-mode `account not found`. Verifies u8 index + u64 id encoding.',
    build: () =>
      buildMangoTcsCancelInvoke({
        userEvmAddress: FRESH_USER_EVM,
        groupHex: MANGO_GROUP,
        buyBankHex: pubkeyBs58ToBytes32('11111111111111111111111111111111'),
        sellBankHex: pubkeyBs58ToBytes32('11111111111111111111111111111111'),
        tcsIndex: 0,
        tcsId: 1n,
      }),
    expect: { revertContains: 'Custom' },
  },
];

export default cases;
