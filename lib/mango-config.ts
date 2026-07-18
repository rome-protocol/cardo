// Mango v4 Spot market config for Cardo `/lend-mango`.
//
// Devnet bootstrap state (verified 2026-04-25):
//   * 43 Group accounts, 112 Bank accounts. 28 banks for canonical WSOL
//     mint, 29 banks for Mango devnet USDC (`8FRFC6Mo…`), plus
//     MNGO/ETH/MSOL/BTC/USDT.
//
// First wiring chooses **SOL** because the canonical WSOL mint
// (`So11…112`) already has a Cardo ERC20-SPL wrapper (WWSOL) on Rome,
// so no new deploy is needed. Mango's Mango-USDC mint
// (`8FRFC6Mo…`) does NOT match Cardo's chain_mint_id and would require
// a separate deploy + bridge story.
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md
// (Family 4/5 — A21 Mango v4).

import type { Hex } from 'viem';
import { pubkeyBs58ToBytes32 } from './solana-pda';

export type MangoBankConfig = {
  /// Display label.
  symbol: string;
  /// Mango Group PDA (multi-bank container).
  groupHex: Hex;
  groupBs58: string;
  /// Bank account (writable in deposit/withdraw).
  bankHex: Hex;
  bankBs58: string;
  /// Bank's SPL ATA (writable; receives the user's tokens on deposit,
  /// pays out on withdraw).
  vaultHex: Hex;
  vaultBs58: string;
  /// Oracle account (read-only).
  oracleHex: Hex;
  /// SPL mint backing the bank.
  mintHex: Hex;
  mintBs58: string;
  /// EVM ERC20-SPL wrapper on Rome that maps to the same SPL.
  wrapper: `0x${string}`;
  /// Mint decimals.
  decimals: number;
};

/// Active bank: Mango v4 "SOL" bank in group `FHnZBXLa…`.
///
/// **Bank-switch 2026-04-25**: the original target bank
/// (`2Rs9sJ6DwB…` in group `55b3nWhi…`, oracle `7UVimffx…` Pyth Push)
/// reverted with `Custom(6023) OracleConfidence` because that bank's
/// `oracle_config.conf_filter` was set to 0 — strictly tight,
/// rejecting ANY positive Pyth confidence band. A scan of all 28
/// canonical-WSOL banks found 4 with `conf_filter=10000` AND
/// `maxStalenessSlots=-1` (effectively no validation). This is one
/// of those.
///
/// Verified via on-chain decode of bank `7trXn2uYWg…`:
///   group   FHnZBXLaKBKLg8Qwzt31Ft2ZDNbkM9j4UWREkYP4o25d
///   vault   AhRv7QQU1kv4zJKup5GcRf45FcDpV8wHtTh6icacevqc
///   oracle  J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix
export const MANGO_SOL_BANK: MangoBankConfig = {
  symbol: 'SOL',
  groupHex: pubkeyBs58ToBytes32(
    'FHnZBXLaKBKLg8Qwzt31Ft2ZDNbkM9j4UWREkYP4o25d',
  ),
  groupBs58: 'FHnZBXLaKBKLg8Qwzt31Ft2ZDNbkM9j4UWREkYP4o25d',
  bankHex: pubkeyBs58ToBytes32(
    '7trXn2uYWg1FSQhVsWw8mwBXeC9K75PnXVkVQcfE57NH',
  ),
  bankBs58: '7trXn2uYWg1FSQhVsWw8mwBXeC9K75PnXVkVQcfE57NH',
  vaultHex: pubkeyBs58ToBytes32(
    'AhRv7QQU1kv4zJKup5GcRf45FcDpV8wHtTh6icacevqc',
  ),
  vaultBs58: 'AhRv7QQU1kv4zJKup5GcRf45FcDpV8wHtTh6icacevqc',
  oracleHex: pubkeyBs58ToBytes32(
    'J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix',
  ),
  mintHex: pubkeyBs58ToBytes32(
    'So11111111111111111111111111111111111111112',
  ),
  mintBs58: 'So11111111111111111111111111111111111111112',
  wrapper: '0xb7c77397143adea219ac03a4005d304af1bfebe3', // WWSOL
  decimals: 9,
};
