// useChainTokens — enumerate live ERC20-SPL wrappers on Rome via the
// Romeswap ERC20SPLFactory (0x1551…5D64).
//
// Flow:
//   1. Read totalTokens() -> N.
//   2. Read tokenSymbols(i) for i in [0, N) — factory-ordered symbols.
//   3. Read tokens(symbol_i) -> wrapper address for each symbol.
//   4. Read symbol()/decimals()/mint_id() on each wrapper so the UI can
//      render without trusting the factory's string arg (and to get the
//      Solana mint for deriveCategory).
//
// The factory today returns totalTokens()==0 on Rome (USDC-A + WSOL-B
// were NOT created via this factory — they were deployed through the
// `ERC20SPLFactory` at 0x3e2f…3e88 from rome-solidity, which uses a
// different ABI and isn't the one Romeswap wired). Rather than teach
// this hook both ABIs, we fall back to a tiny static list of the two
// wrappers we know exist (ROME_STATIC_TOKENS) so the picker + balance
// list still populate. When new SPL tokens get created through the
// Romeswap factory they'll light up here automatically.
//
// Base58 conversion: the wrapper's mint_id() returns bytes32; the UI
// consumer (deriveCategory) compares against base58 mint strings like
// ROME_CHAIN_MINT_ID. `bs58` is already a repo dep.

import { useMemo } from 'react';
import { useReadContract, useReadContracts } from 'wagmi';
import bs58 from 'bs58';
import { erc20Abi, type Address, type Hex } from 'viem';
import { ROME_ADDRESSES, romeStaticTokens } from '@/lib/addresses';
import { useActiveChainId } from '@/lib/env-context';

// Romeswap ERC20SPLFactory — minimal ABI for enumeration.
const FACTORY_ABI = [
  {
    name: 'totalTokens',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'tokenSymbols',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ type: 'uint256' }],
    outputs: [{ type: 'string' }],
  },
  {
    name: 'tokens',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ type: 'string' }],
    outputs: [{ type: 'address' }],
  },
] as const;

// SPL_ERC20 has symbol()/decimals() via standard ERC20 plus a Rome-
// specific mint_id() returning the backing Solana mint as bytes32.
const SPL_ERC20_EXTRA_ABI = [
  {
    name: 'mint_id',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bytes32' }],
  },
] as const;

export type ChainToken = {
  address: Address;
  symbol: string;
  /** Human-readable name (e.g. "Rome-wrapped USDC"). May be undefined for
   *  wrappers returned by the factory enumeration, which exposes only
   *  `symbol()` — the UI can fall back to the symbol itself. */
  name?: string;
  decimals: number;
  /** Base58 SPL mint address (Solana pubkey). */
  mintAddress: string;
  tokenType: 'erc20spl';
  /** Does this token have a live Meteora pool? False means the UI can
   *  display the balance but must disable swap routing. Defaults to
   *  true for factory-enumerated wrappers (they're assumed wired). */
  swappable?: boolean;
};

export type UseChainTokens = {
  tokens: ChainToken[];
  loading: boolean;
  /** True when the factory returned zero tokens and we fell back. */
  fromFallback: boolean;
};

/** Convert a 0x-prefixed 32-byte hex pubkey into its base58 string. */
function bytes32ToBase58(hex: Hex): string {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bs58.encode(bytes);
}

export function useChainTokens(): UseChainTokens {
  const chainId = useActiveChainId();
  // 1. How many tokens has the factory registered?
  const { data: total, isLoading: totalLoading } = useReadContract({
    address: ROME_ADDRESSES.erc20SplFactory,
    abi: FACTORY_ABI,
    functionName: 'totalTokens',
    chainId,
  });

  const n = total !== undefined ? Number(total) : 0;

  // 2. Enumerate factory-ordered symbols.
  const { data: symbolResults, isLoading: symbolsLoading } = useReadContracts({
    contracts: Array.from({ length: n }).map((_, i) => ({
      address: ROME_ADDRESSES.erc20SplFactory,
      abi: FACTORY_ABI,
      functionName: 'tokenSymbols' as const,
      args: [BigInt(i)] as const,
      chainId,
    })),
    query: { enabled: n > 0 },
  });

  const symbols = useMemo<string[]>(() => {
    if (!symbolResults) return [];
    return symbolResults
      .map((r) => (r?.status === 'success' ? (r.result as string) : null))
      .filter((s): s is string => !!s);
  }, [symbolResults]);

  // 3. Resolve symbol -> wrapper address via the factory's `tokens` map.
  const { data: wrapperResults, isLoading: wrappersLoading } = useReadContracts({
    contracts: symbols.map((sym) => ({
      address: ROME_ADDRESSES.erc20SplFactory,
      abi: FACTORY_ABI,
      functionName: 'tokens' as const,
      args: [sym] as const,
      chainId,
    })),
    query: { enabled: symbols.length > 0 },
  });

  const wrappers = useMemo<Address[]>(() => {
    if (!wrapperResults) return [];
    return wrapperResults
      .map((r) => (r?.status === 'success' ? (r.result as Address) : null))
      .filter((a): a is Address => !!a && a !== '0x0000000000000000000000000000000000000000');
  }, [wrapperResults]);

  // 4. Pull symbol/decimals/mint_id from each wrapper for authoritative metadata.
  const { data: metaResults, isLoading: metaLoading } = useReadContracts({
    contracts: wrappers.flatMap((addr) => [
      {
        address: addr,
        abi: erc20Abi,
        functionName: 'symbol' as const,
        chainId,
      },
      {
        address: addr,
        abi: erc20Abi,
        functionName: 'decimals' as const,
        chainId,
      },
      {
        address: addr,
        abi: SPL_ERC20_EXTRA_ABI,
        functionName: 'mint_id' as const,
        chainId,
      },
    ]),
    query: { enabled: wrappers.length > 0 },
  });

  const loading =
    totalLoading || symbolsLoading || wrappersLoading || metaLoading;

  return useMemo(() => {
    // Factory enumeration succeeded with at least one wrapper.
    if (wrappers.length > 0 && metaResults) {
      const tokens: ChainToken[] = [];
      for (let i = 0; i < wrappers.length; i++) {
        const symRes = metaResults[i * 3];
        const decRes = metaResults[i * 3 + 1];
        const mintRes = metaResults[i * 3 + 2];
        if (
          symRes?.status !== 'success' ||
          decRes?.status !== 'success' ||
          mintRes?.status !== 'success'
        ) {
          continue;
        }
        tokens.push({
          address: wrappers[i]!,
          symbol: symRes.result as string,
          decimals: Number(decRes.result as number),
          mintAddress: bytes32ToBase58(mintRes.result as Hex),
          tokenType: 'erc20spl',
        });
      }
      if (tokens.length > 0) {
        return { tokens, loading: false, fromFallback: false };
      }
    }

    // Factory empty (or all reads failed) — fall back to known wrappers.
    // This is the expected path on Rome today: USDC-A + WSOL-B were
    // deployed via a different factory (rome-solidity's), not the
    // Romeswap ERC20SPLFactory enumerated here.
    return {
      tokens: romeStaticTokens(chainId).map((t) => ({
        address: t.address as Address,
        symbol: t.symbol,
        name: t.name,
        decimals: t.decimals,
        mintAddress: t.mintAddress,
        tokenType: 'erc20spl' as const,
        swappable: t.swappable ?? true,
      })),
      loading,
      fromFallback: true,
    };
  }, [wrappers, metaResults, loading, chainId]);
}
