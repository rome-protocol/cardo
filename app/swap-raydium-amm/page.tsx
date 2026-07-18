// Swap-Raydium-AMM route `/swap-raydium-amm` — Raydium AMM v4
// (legacy hand-rolled AMM) `swap_base_in` against the seeded WSOL/USDC
// pool on devnet.
//
// AMM v4 ≠ CPMM. Different program id, different ix shape (single-byte
// u8 tag vs Anchor disc), different account count (18 vs 13), and AMM v4
// CPIs into Serum/OpenBook for orderbook integration.
//
// Verified live 2026-04-26:
//   * devnet program HWy1jot…  executable=true, recent successful
//     swap_base_in invocation (ray_log emitted, 28k CU consumed).
//   * pool 8Mwd2xFB AmmInfo.status = 6 (SwapOnly), 30.4 USDC + 38.76 SOL.
//   * user (Rome EVM 0x3403…0562) PDA already has both ATAs funded.

'use client';

import { useCallback, useMemo } from 'react';
import { SwapRaydiumAmm } from '@/components/screens/SwapRaydiumAmm';
import { useWallet } from '../wallet-context';
import { ENABLED_RAYDIUM_AMM_V4_POOLS } from '@/lib/raydium-amm-pools';
import { useRaydiumAmmV4PoolState } from '@/lib/use-raydium-amm-pool-state';
import { useRaydiumAmmV4Swap } from '@/lib/use-raydium-amm-swap';
import { useSolanaTokenBalances } from '@/lib/use-solana-balances';
import { activeChain } from '@/lib/chain-config';

type SwapArgs = {
  inputIsCoin: boolean;
  amountIn: bigint;
  minimumAmountOut: bigint;
};

// Rome EVM wrappers for the seeded pool's two SPL mints — registry-driven
// (was stale pre-#240 literals). USDC = chain_mint_id wrapper, WSOL = canonical.
const { wUsdc: RUSDC_WRAPPER, wWsol: RWSOL_WRAPPER } = activeChain().wrappers;

export default function Page() {
  const { wallet, connect } = useWallet();
  const pool = ENABLED_RAYDIUM_AMM_V4_POOLS[0];
  const poolState = useRaydiumAmmV4PoolState(pool?.poolBs58 ?? null);
  const { state: swapState, swap } = useRaydiumAmmV4Swap();

  const tokenSpecs = useMemo(
    () =>
      pool
        ? [
            {
              wrapper: RWSOL_WRAPPER,
              mintAddress: 'So11111111111111111111111111111111111111112',
            },
            {
              wrapper: RUSDC_WRAPPER,
              mintAddress: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
            },
          ]
        : [],
    [pool],
  );
  const balances = useSolanaTokenBalances(
    tokenSpecs,
    wallet?.address as `0x${string}` | undefined,
  );

  // Map mint hex → human float. coin = USDC, pc = WSOL on the seeded pool.
  const ataBalancesByMint: Record<string, number> = useMemo(() => {
    if (!pool) return {};
    return {
      [pool.coinMint]:
        Number(balances[RUSDC_WRAPPER] ?? 0n) / 10 ** pool.coinDecimals,
      [pool.pcMint]:
        Number(balances[RWSOL_WRAPPER] ?? 0n) / 10 ** pool.pcDecimals,
    };
  }, [balances, pool]);

  const onSwap = useCallback(
    (args: SwapArgs) => {
      if (!wallet?.address) {
        connect?.();
        return;
      }
      if (!pool) return;
      if (args.amountIn <= 0n) return;
      void swap({
        userEvmAddress: wallet.address as `0x${string}`,
        pool,
        inputIsCoin: args.inputIsCoin,
        amountIn: args.amountIn,
        minimumAmountOut: args.minimumAmountOut,
      });
    },
    [wallet?.address, connect, pool, swap],
  );

  return (
    <SwapRaydiumAmm
      wallet={wallet}
      onConnect={connect}
      pool={pool}
      poolState={poolState}
      ataBalancesByMint={ataBalancesByMint}
      onSwap={onSwap}
      swapState={swapState}
    />
  );
}
