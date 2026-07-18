// useHoldings — the connected wallet's live token holdings on Rome, merged
// from the same sources the Swap screen uses: the chain token list (factory +
// user-deployed), per-wrapper balances (EVM balanceOf with Solana-direct ATA
// fallback), and Oracle Gateway prices. Returns display-ready rows + a USD
// total. Used by the Portfolio dashboard; safe to reuse anywhere holdings are
// shown without re-implementing the balance plumbing.

import { useMemo } from 'react';
import type { Address } from 'viem';
import { useChainTokens } from './use-chain-tokens';
import { useTokenBalances } from './use-token-balances';
import { useSolanaTokenBalances } from './use-solana-balances';
import { useOraclePrices } from './use-oracle-prices';

export type Holding = {
  symbol: string;
  name: string;
  address: Address;
  mintAddress: string;
  decimals: number;
  tokenType?: string;
  balance: number;
  price: number;
  usd: number;
};

// Symbol → Oracle Gateway feed. Strip a leading wrapper prefix (w/r), then
// match the underlying ticker. USDC must precede USDT.
function oracleSymbolFor(symbol: string): string | null {
  let x = (symbol ?? '').toUpperCase();
  if ((x.startsWith('W') || x.startsWith('R')) && x.length > 1) x = x.slice(1);
  if (x === 'WSOL' || x === 'SOL') return 'SOL';
  if (x === 'ETH') return 'ETH';
  if (x === 'BTC') return 'BTC';
  if (x === 'USDC') return 'USDC';
  if (x === 'USDT') return 'USDT';
  return null;
}

export function useHoldings(userEvmAddress: Address | undefined): {
  holdings: Holding[];
  totalUsd: number;
  loading: boolean;
} {
  const { tokens: chainTokens } = useChainTokens();

  const tokenAddresses = useMemo<Address[]>(
    () => chainTokens.map((t) => t.address),
    [chainTokens],
  );
  const { balances: evmBalances } = useTokenBalances(tokenAddresses, userEvmAddress);

  const splTokenSpecs = useMemo(
    () => chainTokens.map((t) => ({ wrapper: t.address, mintAddress: t.mintAddress })),
    [chainTokens],
  );
  const solBalances = useSolanaTokenBalances(splTokenSpecs, userEvmAddress);

  const { prices, loading: pricesLoading } = useOraclePrices();

  const holdings = useMemo<Holding[]>(() => {
    const rows: Holding[] = [];
    for (const t of chainTokens) {
      const key = t.address.toLowerCase();
      const raw = solBalances[key] ?? evmBalances[key];
      if (raw === undefined) continue;
      const balance = Number(raw) / 10 ** t.decimals;
      const oracleSym = oracleSymbolFor(t.symbol);
      const price = oracleSym ? (prices?.[oracleSym]?.usd ?? 0) : 0;
      rows.push({
        symbol: t.symbol,
        name: t.name ?? t.symbol,
        address: t.address,
        mintAddress: t.mintAddress,
        decimals: t.decimals,
        tokenType: t.tokenType,
        balance,
        price,
        usd: balance * price,
      });
    }
    // Held first, then by USD value desc.
    return rows.sort((a, b) => (b.balance > 0 ? 1 : 0) - (a.balance > 0 ? 1 : 0) || b.usd - a.usd);
  }, [chainTokens, evmBalances, solBalances, prices]);

  const totalUsd = useMemo(() => holdings.reduce((sum, h) => sum + h.usd, 0), [holdings]);

  return { holdings, totalUsd, loading: pricesLoading };
}
