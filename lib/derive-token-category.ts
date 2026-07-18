// Canonical token-category model for Rome EVM chains.
//
// Source: the docs/active/design/token-types-on-rome-evm.md §6.
//
// Four mutually-exclusive categories: native-gas, wrapped-native, erc20,
// wrapped-spl. Category is determined by how the token was introduced to
// the chain (stable for the token's lifetime), so this is a pure function
// and can be inlined anywhere we render a token row.

export type TokenCategory =
  | 'native-gas'
  | 'wrapped-native'
  | 'erc20'
  | 'wrapped-spl';

export type TokenInput = {
  address: string; // '0x…' or 'native'
  isNative?: boolean;
  tokenType?: 'erc20' | 'erc20spl';
  mintAddress?: string; // base58 Solana mint, if ERC20-SPL
};

/**
 * Derive the canonical category for a token. Spec §6.
 * Pure function; inline-safe.
 */
export function deriveCategory(
  token: TokenInput,
  chainMintId: string | null,
): TokenCategory {
  if (token.isNative || token.address === 'native') return 'native-gas';
  if (token.mintAddress && token.mintAddress === chainMintId) return 'wrapped-native';
  if (token.tokenType === 'erc20spl') return 'wrapped-spl';
  return 'erc20';
}

/**
 * Display metadata per category — from spec §2 + §3.1.
 *   - `label`        : badge text (uppercase mono pill)
 *   - `subtitle`     : row subtitle copy
 *   - `badgeColor`   : 'accent' = purple text on accent-soft bg (GAS/WRAP/WRAPPED-SPL)
 *                      'neutral' = stone-400 text on paper bg (ERC20)
 */
export const CATEGORY_META: Record<
  TokenCategory,
  {
    label: string;
    subtitle: string;
    badgeColor: 'accent' | 'neutral';
  }
> = {
  'native-gas': {
    label: 'GAS',
    subtitle: 'gas token · pays fees',
    badgeColor: 'accent',
  },
  'wrapped-native': {
    label: 'WRAP',
    subtitle: 'Rome-wrapped · ERC20 · usable in Romeswap / CPI',
    badgeColor: 'accent',
  },
  erc20: {
    label: 'ERC20',
    subtitle: 'ERC20 on Rome',
    badgeColor: 'neutral',
  },
  'wrapped-spl': {
    label: 'WRAPPED SPL',
    subtitle: 'Wrapped SPL · Solana mint on Rome',
    badgeColor: 'neutral',
  },
};
