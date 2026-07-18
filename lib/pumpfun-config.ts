// Pump.fun page default config for `/swap-pumpfun`.
//
// The page accepts `?mint=<bs58>` to switch to any active bonding
// curve. The default below is just a seeded discovery; users can
// paste any Pump.fun memecoin mint.
//
// Devnet bootstrap (verified 2026-04-25):
//   * Pump.fun program 6EF8rrec…  executable
//   * Active mint default: 6U5vuXsvZ4R55h3GFtUfsmiJHijVu6te48HbGqvvpump
//     (extracted from a recent successful buy tx; pump-suffix vanity
//      address per Pump.fun convention)
//   * Curve PDA: 4wP6kVhHaCXLYjDejfZ48nqEaPkSsBZJeSRBPMUYFG2v
//   * Real SOL reserves: ~0.001 SOL (any small buy executes)

import type { Hex } from 'viem';
import { pubkeyBs58ToBytes32 } from './solana-pda';

export type PumpfunPageConfig = {
  /// Memecoin mint (bs58).
  mintBs58: string;
  /// Memecoin mint as bytes32 hex.
  mintHex: Hex;
  /// Display label.
  symbol: string;
  /// Mint decimals (Pump.fun standard is 6).
  decimals: number;
};

export const PUMPFUN_DEFAULT: PumpfunPageConfig = {
  mintBs58: '6U5vuXsvZ4R55h3GFtUfsmiJHijVu6te48HbGqvvpump',
  mintHex: pubkeyBs58ToBytes32(
    '6U5vuXsvZ4R55h3GFtUfsmiJHijVu6te48HbGqvvpump',
  ),
  symbol: 'PUMP',
  decimals: 6,
};
