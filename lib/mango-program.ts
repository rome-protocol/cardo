// Mango v4 program constants for the Cardo deposit/withdraw integration.
//
// **Source of truth**: github.com/blockworks-foundation/mango-v4 + the
// IDL at /tmp/mango_v4.json (cached 2026-04-25, 130KB+).
//
// Devnet bootstrap state (verified 2026-04-25):
//   - Mango v4 (4MangoMjqJ2firMokCjjGgoK8d4MXcrgL7XJaL3w6fVg) ✓
//   - 43 Group accounts, 809 program accounts total ✓
//   - 28 canonical-WSOL banks, 29 USDC banks (Mango USDC mint), MNGO/ETH/MSOL/BTC banks ✓
//   - Sample SOL bank (first matched): `2Rs9sJ6DwBHbjhfeLxMqvRe7qhGhgiLZsBPe3jXZdszL`
//     in group `55b3nWhitDWMwAMnhkxMmYNfbZDXzAm6SfSgfoAp3qni`,
//     vault `EzPUPCJKJiNboVWnsSeY6XiQz9QUi43Sduk9qYMCxvdR`,
//     oracle `7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE` (Pyth pull)
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md
// (Family 4/5 — A21 Mango v4).

import type { Hex } from 'viem';
import { pubkeyBs58ToBytes32 } from './solana-pda';
import { solanaProgramId } from './solana-programs';

// ─────────────────────────────────────────────────────────────────────
// Program id (from @rome-protocol/registry).
// Mango v4 — same address on devnet + mainnet.
// ─────────────────────────────────────────────────────────────────────

export const MANGO_V4_PROGRAM: Hex = pubkeyBs58ToBytes32(
  solanaProgramId('mangoV4', 'devnet'),
);

// ─────────────────────────────────────────────────────────────────────
// Anchor instruction discriminators — sha256("global:<rust_fn_name>")[..8].
//
// Mango v4 IDL exposes `accountCreate` / `tokenDeposit` / `tokenWithdraw`
// (camelCase) but the rust source uses snake_case (`account_create`,
// `token_deposit`, `token_withdraw`). Anchor hashes the rust fn name,
// not the IDL camelCase.
//
// Verified by decoding a real on-chain Mango account_create tx on
// devnet (sig `3tYaPY7Eevf4mTL3K67LcqYrqsko6jwJeZ3oCvP3EsHni4AbhxDsb28Qps2BBddP6Gk1eekJmHWtp32nJQEfivsN`,
// disc bytes = `c65f27c529d69d12` ✓). Same `feedback_anchor_disc_casing`
// rule we hit in Drift.
// ─────────────────────────────────────────────────────────────────────

/// `account_create(account_num, token_count, serum3_count, perp_count,
/// perp_oo_count, name)` — creates a fresh MangoAccount PDA for the
/// caller. 5 accounts: group, account (PDA), owner (signer),
/// payer (signer, writable), systemProgram.
export const ACCOUNT_CREATE_DISC: Hex = '0xc65f27c529d69d12';

/// `account_create_v2(..., token_conditional_swap_count, name)` — newer
/// variant with TCS slots. Same account list as account_create.
export const ACCOUNT_CREATE_V2_DISC: Hex = '0xc28856a7f986c7b2';

/// `token_deposit(amount: u64, reduceOnly: bool)` — 9 accounts:
/// group, account (writable), owner (signer), bank (writable),
/// vault (writable), oracle, tokenAccount (writable),
/// tokenAuthority (signer), tokenProgram.
export const TOKEN_DEPOSIT_DISC: Hex = '0x75ff9a47f53a5f59';

/// `token_withdraw(amount: u64, allowBorrow: bool)` — 8 accounts:
/// group, account (writable), owner (signer), bank (writable),
/// vault (writable), oracle, tokenAccount (writable), tokenProgram.
export const TOKEN_WITHDRAW_DISC: Hex = '0x3fdf2a3b0f806642';

/// `account_close` — close a MangoAccount, return rent to sol_destination.
/// 5 accounts: group (ro), account (rw, has_one=group, has_one=owner),
/// owner (signer), sol_destination (rw), token_program (ro).
/// `sha256("global:account_close")[..8]` — verified.
export const ACCOUNT_CLOSE_DISC: Hex = '0x7305c01c56dd8966';

/// `account_edit` — modify name + delegate fields on a MangoAccount.
/// 3 accounts: group (ro), account (rw), owner (signer).
/// `sha256("global:account_edit")[..8]` — verified.
export const ACCOUNT_EDIT_DISC: Hex = '0xbad3cdb7735d18a1';

/// `account_expand` — grow MangoAccount slot counts (token/serum3/
/// perp/perp_oo). 5 accounts. `sha256("global:account_expand")[..8]`
/// verified.
export const ACCOUNT_EXPAND_DISC: Hex = '0x58d41f74fdc95101';

/// `token_conditional_swap_create` — stop-loss / take-profit primitive.
/// 5 accounts: group (ro), account (rw, has_one=group, owner=signer),
/// authority (signer), buy_bank (ro), sell_bank (ro).
/// `sha256("global:token_conditional_swap_create")[..8]` verified.
export const TCS_CREATE_DISC: Hex = '0x56fdfe4aea55c159';

/// `token_conditional_swap_cancel` — cancels an existing TCS.
/// 5 accounts: group (ro), account (rw), authority (signer),
/// buy_bank (rw), sell_bank (rw).
/// `sha256("global:token_conditional_swap_cancel")[..8]` verified.
export const TCS_CANCEL_DISC: Hex = '0x82d15339efffa2ce';

// ─────────────────────────────────────────────────────────────────────
// PDA seeds
// ─────────────────────────────────────────────────────────────────────

/// MangoAccount PDA: PDA(["MangoAccount", group, owner, account_num_le_u32], MANGO_V4_PROGRAM).
export const MANGO_ACCOUNT_SEED = Buffer.from('MangoAccount');

// ─────────────────────────────────────────────────────────────────────
// Bank account
// ─────────────────────────────────────────────────────────────────────

/// IDL discriminator for the `Bank` account (Anchor:
/// `sha256("account:Bank")[..8]`). bs58 = `QnTef4UXSzF`.
export const BANK_DISC: number[] = [142, 49, 166, 242, 50, 66, 97, 188];

/// Bank field offsets — first 152 bytes carry everything Cardo needs:
///   8..40   group              (32 bytes)
///   40..56  name               (16 bytes utf8 padded with 0x00)
///   56..88  mint               (32 bytes)  ← match-on field
///   88..120 vault              (32 bytes)  ← Bank's SPL ATA
///   120..152 oracle            (32 bytes)
export const BANK_FIELD_OFFSETS = {
  group: 8,
  name: 40,
  mint: 56,
  vault: 88,
  oracle: 120,
} as const;

// ─────────────────────────────────────────────────────────────────────
// Default account-create slot counts
//
// MangoAccount sizes its dynamic arrays at creation time. Sensible
// defaults for a Cardo user who's only ever going to deposit/withdraw a
// single token: 8 token slots, 0 serum3 / perp / perp-OO / TCS.
// ─────────────────────────────────────────────────────────────────────

export const DEFAULT_TOKEN_COUNT = 8;
export const DEFAULT_SERUM3_COUNT = 0;
export const DEFAULT_PERP_COUNT = 0;
export const DEFAULT_PERP_OO_COUNT = 0;
export const DEFAULT_TCS_COUNT = 0;

// ─────────────────────────────────────────────────────────────────────
// CU budgets (empirical estimates; revisit after live runs)
// ─────────────────────────────────────────────────────────────────────

export const CU_ACCOUNT_CREATE = 80_000n;
export const CU_TOKEN_DEPOSIT = 200_000n;
export const CU_TOKEN_WITHDRAW = 220_000n;
