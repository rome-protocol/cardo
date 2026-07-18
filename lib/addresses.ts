// Rome deployed addresses — registry-driven, resolved at CALL time.
//
// This module USED to hardcode the pre-#240 ERC20-SPL wrappers, Oracle
// Gateway V2 adapters, factories, and chain_mint_id for the retired
// chain 999999, and then (until 2026-07-06) froze `activeChain()` at module
// load — which pinned every value to the client bundle's BOOT default
// (Hadrian) regardless of the deployment's runtime chain or the header
// switcher. Values now resolve per access:
//
//   - `ROME_ADDRESSES.*` are getters over the active chain (stable object
//     identities per chain — they come straight off the CHAINS map).
//   - `romeStaticTokens()` / `romeChainMintId()` take an optional chainId and
//     default to the runtime chain; the token list is memoized per chain so
//     it is identity-stable and safe in React hook deps.
//
// Write paths (swap, pool init, vault init, ATA init, Kamino setup) go
// direct to the CPI precompile from the user's EOA; cost previews derive
// from wagmi `estimateGas` + Oracle Gateway V2 prices + per-protocol
// constants.

import type { Address } from 'viem';
import { activeChain } from './chain-config';

export const ROME_ADDRESSES = {
  // Oracle Gateway V2 per-feed adapters (Chainlink-compatible Pyth Pull /
  // Switchboard V3). All return `latestRoundData()` with 8-decimal USD in
  // `answer`. Sourced from registry `chains/<id>/oracle.json#feeds`.
  get oracles() {
    return activeChain().oracles;
  },

  // Canonical SPL-backed wrappers (cached `SPL_ERC20_cached`, deployed by
  // the registry's ERC20SPLFactory). Keys keep Cardo's legacy field names
  // (wUsdc/wEth/wWsol); values come from registry `chains/<id>/tokens.json`.
  get tokens() {
    return activeChain().wrappers;
  },

  // ERC20-SPL factory (live version from registry contracts.json). There
  // is one canonical factory per chain now; both fields point at it (the
  // historical Romeswap-variant distinction is gone).
  get erc20SplFactory() {
    return activeChain().erc20SplFactory;
  },
  get erc20SplFactoryCanonical() {
    return activeChain().erc20SplFactory;
  },
} as const;

export type ChainStaticToken = {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  mintAddress: string;
  swappable: boolean;
};

// LST wrappers on Hadrian, routable on /swap via the seeded Meteora
// DAMM v1 pools in lib/meteora-pool.ts. These are cardo-deployed
// ERC20SPLFactory outputs over test assets, so per the registry's
// curation policy they live here rather than in registry tokens.json
// (same precedent as the Phoenix market constants):
//   - mSOL: REAL devnet Marinade mint — users mint it in-product via
//     /stake-marinade, then swap it here.
//   - wJitoSOL: Wormhole-wrapped JitoSOL (Sepolia origin 0x46FF8Fc9…);
//     no mintable Jito stake pool exists on devnet.
const HADRIAN_LST_TOKENS: ChainStaticToken[] = [
  {
    address: '0x0ea6e66d26c5e1f6fd3886a080db837b841c5b89',
    symbol: 'mSOL',
    name: 'Marinade staked SOL (devnet)',
    decimals: 9,
    mintAddress: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
    swappable: true,
  },
  {
    address: '0xff2a3460a694119c0d777f37eb983ad970afcaa9',
    symbol: 'wJitoSOL',
    name: 'Rome Wrapped JitoSOL',
    decimals: 8,
    mintAddress: '8uz9RSxeKQxS1q3Cvs8xzNDTapUdJWRZhcHG2GegEtMS',
    swappable: true,
  },
];

const staticTokensByChain = new Map<number, ChainStaticToken[]>();

// Static token surface for `useChainTokens` and the pay/send/name
// pickers — the canonical SPL-backed wrappers (w-prefix) on the active
// chain. Derived from the registry token list; `swappable` is true for
// the canonical wrappers (the live chains carry UV3/UV4/Meteora pools
// for wUSDC/wETH/wSOL). Long-tail / locally-minted ERC20s are discovered
// dynamically via the factory's TokenCreated event, not listed here —
// except the Hadrian LST set above, which is pinned because it backs
// curated /swap pools. Memoized per chain (identity-stable for hook deps).
export function romeStaticTokens(chainId?: number): ChainStaticToken[] {
  const chain = activeChain(chainId);
  let tokens = staticTokensByChain.get(chain.id);
  if (!tokens) {
    tokens = chain.tokens
      .filter((t) => t.kind === 'spl_wrapper')
      .map((t) => ({
        address: t.address as Address,
        symbol: t.symbol,
        name: t.name,
        decimals: t.decimals,
        mintAddress: t.mintId,
        swappable: true,
      }))
      .concat(chain.id === 200010 ? HADRIAN_LST_TOKENS : []);
    staticTokensByChain.set(chain.id, tokens);
  }
  return tokens;
}

// Rome `chain_mint_id` — the SPL mint backing the chain's native gas
// token. On Rome that's Circle's devnet USDC mint, so users pay fees in
// USDC. The wrapped-native ERC20 surface is the wUSDC wrapper above.
//
// Per the docs token-types-on-rome-evm §1.1: native gas has no ERC20
// surface — it's an entry in the Balance PDA on Solana; the chain_mint_id
// is the source of truth for which SPL backs it.
export function romeChainMintId(chainId?: number): string {
  return activeChain(chainId).chainMintId;
}
