// Orca route `/orca` — Orca Whirlpool swap (concentrated liquidity) in the
// act|see dark design. A second swap dapp alongside Meteora's /swap, using the
// live devnet WSOL/USDC whirlpool (reachable on Hadrian's Solana substrate).
// Reuses the tested Orca builders/hooks; the screen owns quote + minOut.

'use client';

import { useCallback, useMemo, useState } from 'react';
import type { Address, Hex } from 'viem';
import { Orca } from '@/components/screens/Orca';
import { useWallet } from '../wallet-context';
import { ENABLED_ORCA_POOLS } from '@/lib/orca-pools';
import { useOrcaPoolState } from '@/lib/use-orca-pool-state';
import { useOrcaSwap } from '@/lib/use-orca-swap';
import { useAtaInit } from '@/lib/use-ata-init';
import { useSolanaTokenBalances } from '@/lib/use-solana-balances';
import { bytes32ToPublicKey } from '@/lib/solana-pda';

type SwapArgs = { aToB: boolean; amountHuman: number; otherAmountThreshold: bigint };

export default function Page() {
  const { wallet, connect } = useWallet();
  const [poolLabel, setPoolLabel] = useState(ENABLED_ORCA_POOLS[0].label);
  const pool =
    ENABLED_ORCA_POOLS.find((p) => p.label === poolLabel) ?? ENABLED_ORCA_POOLS[0];
  const poolState = useOrcaPoolState(pool);
  const { state: swapState, swap } = useOrcaSwap();
  const { state: ataInitState, init: ataInit } = useAtaInit();

  // Balances: useSolanaTokenBalances reads each mint's ATA under the user's
  // Rome PDA (the wrapper field is only a map key). Re-key by mint hex.
  const KEY_A = '0x0000000000000000000000000000000000000a01' as Address;
  const KEY_B = '0x0000000000000000000000000000000000000b02' as Address;
  const tokenSpecs = useMemo(
    () =>
      pool
        ? [
            { wrapper: KEY_A, mintAddress: bytes32ToPublicKey(pool.tokenMintA).toBase58() },
            { wrapper: KEY_B, mintAddress: bytes32ToPublicKey(pool.tokenMintB).toBase58() },
          ]
        : [],
    [pool],
  );
  const balances = useSolanaTokenBalances(
    tokenSpecs,
    wallet?.address as Address | undefined,
  );
  const ataBalancesByMint = useMemo<Record<string, number>>(() => {
    if (!pool) return {};
    return {
      [pool.tokenMintA]: Number(balances[KEY_A] ?? 0n) / 10 ** pool.tokenDecimalsA,
      [pool.tokenMintB]: Number(balances[KEY_B] ?? 0n) / 10 ** pool.tokenDecimalsB,
    };
  }, [balances, pool]);

  const onSwap = useCallback(
    (args: SwapArgs) => {
      if (!wallet?.address) {
        connect?.();
        return;
      }
      if (!pool || poolState.currentTick === undefined) return;
      const inDecimals = args.aToB ? pool.tokenDecimalsA : pool.tokenDecimalsB;
      const amount = BigInt(Math.floor(args.amountHuman * 10 ** inDecimals));
      if (amount <= 0n) return;
      void swap({
        userEvmAddress: wallet.address as Address,
        pool,
        currentTick: poolState.currentTick,
        aToB: args.aToB,
        amount,
        otherAmountThreshold: args.otherAmountThreshold,
        label: args.aToB ? `${pool.symbolA} → ${pool.symbolB}` : `${pool.symbolB} → ${pool.symbolA}`,
      });
    },
    [wallet?.address, connect, pool, poolState.currentTick, swap],
  );

  const onCreateAta = useCallback(
    (mintHex: Hex) => {
      if (!wallet?.address) {
        connect?.();
        return;
      }
      void ataInit({ userEvmAddress: wallet.address as Address, mintHex });
    },
    [wallet?.address, connect, ataInit],
  );

  return (
    <Orca
      wallet={wallet}
      onConnect={connect}
      pool={pool}
      pools={ENABLED_ORCA_POOLS}
      onSelectPool={setPoolLabel}
      poolState={poolState}
      ataBalancesByMint={ataBalancesByMint}
      onSwap={onSwap}
      swapState={swapState}
      onCreateAta={onCreateAta}
      ataInitState={ataInitState}
    />
  );
}
