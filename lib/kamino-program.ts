// Kamino Lend (KLend v2) program constants for the Cardo /lend integration.
//
// **Source of truth: github.com/Kamino-Finance/klend** (the on-chain
// program's Anchor source). Specifically:
//   programs/klend/src/lib.rs                  — instruction names + entry points
//   programs/klend/src/handlers/handler_*.rs   — per-action account structs
//   programs/klend/src/utils/seeds.rs          — PDA seed constants
//   programs/klend/src/state/{reserve,obligation}.rs — account layouts
//
// Earlier versions of this file pointed at rome-showcase's
// KaminoLendProgram.sol as &quot;source of truth&quot;. That was a mistake —
// rome-showcase shipped a hypothesis (golden-tested encoder) that
// diverged from klend's actual struct in three places (slot 11+12+13
// layout, v1 vs v2 discriminator names, refresh-chain enforcement).
// First user submission reverted with Anchor 3007. Per playbook §4.4:
// adapter that's never landed a real tx is a hypothesis, not a source
// of truth. Always cross-reference the on-chain program source.
//
// All discriminators below are recomputed from the klend source name
// strings via sha256(&quot;global:&lt;name&gt;&quot;)[..8].
//
// We use direct-precompile from EOA (msg.sender == userEoa at the CPI
// precompile) so Rome auto-signs as the user's external-authority PDA,
// which owns the user's SPL ATAs on the Solana side. Per the
// integration triage at
//   the docs/active/technical/2026-04-25-cardo-lend-kamino-triage.md.

import type { Hex } from 'viem';
import { pubkeyBs58ToBytes32 } from './solana-pda';
import { solanaProgramId } from './solana-programs';

/// KLend program ID (from @rome-protocol/registry). Mainnet only —
/// no devnet deploy of klend exists (cardo's lend flows mock it on
/// Rome via Rome CPI).
export const KLEND_PROGRAM: Hex = pubkeyBs58ToBytes32(
  solanaProgramId('kaminoLend', 'mainnet'),
);

// ─────────────────────────────────────────────────────────────────────
// Anchor instruction discriminators — sha256("global:<method>")[..8]
// ─────────────────────────────────────────────────────────────────────

/// init_user_metadata. Required ONCE per user before any obligation.
/// Kamino v2 introduced UserMetadata as a pre-obligation account.
export const INIT_USER_METADATA_DISC: Hex = '0x75a9b045c5170fa2';

/// init_obligation. Vanilla obligation per (user, market). Required
/// before deposit/withdraw/borrow/repay.
export const INIT_OBLIGATION_DISC: Hex = '0xfb0ae74c1b0b9f60';

/// deposit_reserve_liquidity_and_obligation_collateral
/// data = disc ++ u64le(liquidityAmount)
export const DEPOSIT_DISC: Hex = '0x81c70402de271a2e';

/// withdraw_obligation_collateral_and_redeem_reserve_liquidity_v2
/// data = disc ++ u64le(collateralAmount)
export const WITHDRAW_DISC: Hex = '0x87202d4bef8d8aa5';

/// borrow_obligation_liquidity_v2
/// data = disc ++ u64le(liquidityAmount)
export const BORROW_DISC: Hex = '0xa1808ff5abc7c206';

/// repay_obligation_liquidity_v2
/// data = disc ++ u64le(liquidityAmount)
export const REPAY_DISC: Hex = '0x74aed54cb435d290';

/// refresh_reserve. No args; bundle one per touched reserve before any
/// write op so Kamino's interest accrual + price-stale checks pass.
export const REFRESH_RESERVE_DISC: Hex = '0x02da8aeb4fc91966';

/// refresh_obligation. No args; bundle once after refresh_reserve so
/// the obligation's collateral / debt values reflect the refreshed
/// reserve states.
export const REFRESH_OBLIGATION_DISC: Hex = '0x218493e497c04859';

// ─────────────────────────────────────────────────────────────────────
// Anchor account discriminators — sha256("account:<Name>")[..8]
// Used by polling hooks to filter program accounts.
// ─────────────────────────────────────────────────────────────────────

export const RESERVE_ACCOUNT_DISC: Hex = '0x2bf2ccca1af73b7f';
export const OBLIGATION_ACCOUNT_DISC: Hex = '0xa8ce8d6a584caca7';
export const LENDING_MARKET_ACCOUNT_DISC: Hex = '0xf6723262489d1c78';
export const USER_METADATA_ACCOUNT_DISC: Hex = '0x9dd6dceb6287ab1c';

// ─────────────────────────────────────────────────────────────────────
// CU budgets per write op + refresh chain.
//
// Empirical mainnet-fork measurements (recon 2026-04-22).
// One Rome tx ceiling is 1.4M CU + 256 KB heap — bundling refresh +
// action for a single-collateral obligation fits comfortably.
//
// Re-measure after any Kamino program upgrade.
// ─────────────────────────────────────────────────────────────────────

export const CU_DEPOSIT = 180_000n;
export const CU_WITHDRAW = 150_000n;
export const CU_BORROW = 200_000n;
export const CU_REPAY = 160_000n;
export const CU_REFRESH = 120_000n; // per refresh_reserve / refresh_obligation
