// SPL Token classic — extension ix unhappy-path cases.
//
// Pairs with `lib/spl-token-extensions.ts`. Each case targets one of
// the new builders (Approve, Revoke, Burn, CloseAccount) with FRESH_USER
// inputs that don't have a source ATA on Solana devnet. Rome's
// strict-mode loader catches the missing ATA before the SPL Token
// program runs.

import {
  AUTHORITY_TYPE_ACCOUNT_OWNER,
  AUTHORITY_TYPE_MINT_TOKENS,
  buildSplApproveCheckedInvoke,
  buildSplBurnCheckedInvoke,
  buildSplCloseAccountInvoke,
  buildSplRevokeInvoke,
  buildSplSetAuthorityInvoke,
  buildSplSyncNativeInvoke,
} from '../../lib/spl-token-extensions';
import { pubkeyBs58ToBytes32 } from '../../lib/solana-pda';
import type { TestCaseFile } from '../lib/case';

const FRESH_USER_EVM = '0x000000000000000000000000000000000000d017' as const;

// Circle USDC devnet mint — same one Cardo uses for WUSDC. Picking
// a real mint so we get past any pre-strict-mode wrappers; the
// unhappy lever is the user's missing ATA, not the mint.
const USDC_DEVNET = pubkeyBs58ToBytes32(
  '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
);

// Some delegate pubkey for Approve cases. Doesn't need to be real —
// the loader rejects upstream of the program's delegate validation.
const DELEGATE = pubkeyBs58ToBytes32(
  '11111111111111111111111111111111',
);

const cases: TestCaseFile = [
  {
    name: 'spl-token.approve.fresh-user-no-source-ata',
    description:
      'ApproveChecked from a fresh user → source ATA holds no token-account data → SPL Token program rejects with `InvalidAccountData`. Post emulator refactor (the Rome EVM program #266 + #305, May 2026) the program-level check fires before the strict-mode loader.',
    build: () =>
      buildSplApproveCheckedInvoke({
        userEvmAddress: FRESH_USER_EVM,
        mintHex: USDC_DEVNET,
        delegateHex: DELEGATE,
        amount: 1_000n,
        decimals: 6,
      }),
    expect: { revertContains: 'InvalidAccountData' },
  },
  {
    name: 'spl-token.revoke.fresh-user-no-source-ata',
    description:
      'Revoke from a fresh user → source ATA holds no token-account data → SPL Token rejects with `InvalidAccountData`.',
    build: () =>
      buildSplRevokeInvoke({
        userEvmAddress: FRESH_USER_EVM,
        mintHex: USDC_DEVNET,
      }),
    expect: { revertContains: 'InvalidAccountData' },
  },
  {
    name: 'spl-token.burn.fresh-user-no-source-ata',
    description:
      'BurnChecked from a fresh user → source ATA holds no token-account data → SPL Token rejects with `InvalidAccountData`.',
    build: () =>
      buildSplBurnCheckedInvoke({
        userEvmAddress: FRESH_USER_EVM,
        mintHex: USDC_DEVNET,
        amount: 1n,
        decimals: 6,
      }),
    expect: { revertContains: 'InvalidAccountData' },
  },
  {
    name: 'spl-token.close-account.fresh-user-no-source-ata',
    description:
      'CloseAccount from a fresh user → source ATA holds no token-account data → SPL Token rejects with `InvalidAccountData`.',
    build: () =>
      buildSplCloseAccountInvoke({
        userEvmAddress: FRESH_USER_EVM,
        mintHex: USDC_DEVNET,
      }),
    expect: { revertContains: 'InvalidAccountData' },
  },
  {
    name: 'spl-token.set-authority-token-account.fresh-user-no-source-ata',
    description:
      'SetAuthority on a token account from fresh user → SPL Token rejects with `InvalidArgument` (unset target slot).',
    build: () =>
      buildSplSetAuthorityInvoke({
        userEvmAddress: FRESH_USER_EVM,
        target: 'token-account',
        mintHex: USDC_DEVNET,
        authorityType: AUTHORITY_TYPE_ACCOUNT_OWNER,
        newAuthorityHex: DELEGATE,
      }),
    expect: { revertContains: 'InvalidArgument' },
  },
  {
    name: 'spl-token.set-authority-mint-clear.fresh-user-no-mint-ownership',
    description:
      'SetAuthority on a mint with new_authority=null (burn the authority). Fresh user is not the mint authority of USDC devnet, so SPL Token reverts with `OwnerMismatch` (Custom(4)). Verifies the Option<Pubkey>::None encoding round-trips.',
    build: () =>
      buildSplSetAuthorityInvoke({
        userEvmAddress: FRESH_USER_EVM,
        target: 'mint',
        mintHex: USDC_DEVNET,
        authorityType: AUTHORITY_TYPE_MINT_TOKENS,
        newAuthorityHex: null,
      }),
    expect: {
      // SPL Token program-level OwnerMismatch (Custom(4)) — fresh user
      // doesn't own the USDC mint authority. Confirms the SetAuthority
      // calldata + Option<Pubkey>::None encoding round-trip into a
      // valid program-level rejection.
      revertContains: 'Custom',
    },
  },
  {
    name: 'spl-token.sync-native.fresh-user-no-wsol-ata',
    description:
      'SyncNative from a fresh user → wrapped-SOL ATA does not exist → SPL Token rejects with `IncorrectProgramId`.',
    build: () =>
      buildSplSyncNativeInvoke({
        userEvmAddress: FRESH_USER_EVM,
        wsolMintHex: pubkeyBs58ToBytes32(
          'So11111111111111111111111111111111111111112',
        ),
      }),
    expect: { revertContains: 'IncorrectProgramId' },
  },
];

export default cases;
