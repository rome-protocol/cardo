// Lend-Drift route `/lend-drift` — Drift v2 Spot deposit/withdraw
// against an existing devnet market. Default wiring: WWSOL ↔ Drift SOL
// (market_index 1).
//
// Flow:
//   1. WrapperGate ensures the WWSOL wrapper exists and the user is
//      bound. (Already in ROME_STATIC_TOKENS so this is a pass-through
//      until a different market lands without a wrapper.)
//   2. SpotDrift screen advances the user through:
//        a. initializeUserStats (one-time per authority)
//        b. initializeUser (one-time per authority+subAcct)
//        c. deposit / withdraw (per action)
//   3. After a successful tx, balances refetch and the screen flips to
//      the next step. `useDriftSpotInitState` polls every 8s so the
//      step transition lands without an explicit refresh.
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md
// (Family 5 — Drift Spot deposit/withdraw).

'use client';

import { useCallback, useMemo } from 'react';
import { SpotDrift } from '@/components/screens/SpotDrift';
import { WrapperGate } from '@/components/WrapperGate';
import { useWallet } from '../wallet-context';
import { DRIFT_SPOT_SOL } from '@/lib/drift-spot-config';
import { useSolanaTokenBalances } from '@/lib/use-solana-balances';
import {
  useDriftDeposit,
  useDriftInitStats,
  useDriftInitUser,
  useDriftSpotInitState,
  useDriftWithdraw,
} from '@/lib/use-drift-spot';

type ActionArgs = { amount: number };

export default function Page() {
  const { wallet, connect } = useWallet();
  const market = DRIFT_SPOT_SOL;
  const initFlags = useDriftSpotInitState(
    wallet?.address as `0x${string}` | undefined,
    0,
  );
  const { state: initStatsState, init: doInitStats } = useDriftInitStats();
  const { state: initUserState, init: doInitUser } = useDriftInitUser();
  const { state: depositState, deposit: doDeposit } = useDriftDeposit();
  const { state: withdrawState, withdraw: doWithdraw } = useDriftWithdraw();

  // SOL ATA balance via the existing wrapper-keyed Solana balances hook.
  const tokenSpecs = useMemo(
    () => [{ wrapper: market.wrapper, mintAddress: market.mintBs58 }],
    [market],
  );
  const balances = useSolanaTokenBalances(
    tokenSpecs,
    wallet?.address as `0x${string}` | undefined,
  );
  const ataBalancesByMint: Record<string, number> = useMemo(() => {
    const raw = balances[market.wrapper.toLowerCase()] ?? 0n;
    return {
      [market.mintBs58]: Number(raw) / 10 ** market.decimals,
    };
  }, [balances, market]);

  const onInitStats = useCallback(() => {
    if (!wallet?.address) {
      connect?.();
      return;
    }
    void doInitStats({ userEvmAddress: wallet.address as `0x${string}` });
  }, [wallet?.address, connect, doInitStats]);

  const onInitUser = useCallback(() => {
    if (!wallet?.address) {
      connect?.();
      return;
    }
    void doInitUser({
      userEvmAddress: wallet.address as `0x${string}`,
      subAccountId: 0,
      name: 'Cardo',
    });
  }, [wallet?.address, connect, doInitUser]);

  const onDeposit = useCallback(
    (args: ActionArgs) => {
      if (!wallet?.address) {
        connect?.();
        return;
      }
      const raw = BigInt(Math.floor(args.amount * 10 ** market.decimals));
      if (raw <= 0n) return;
      void doDeposit({
        userEvmAddress: wallet.address as `0x${string}`,
        marketIndex: market.marketIndex,
        mint: market.mintHex,
        spotMarketVault: market.spotMarketVault,
        spotMarketPda: market.spotMarketPda,
        oraclePda: market.oraclePda,
        amount: raw,
        reduceOnly: false,
        subAccountId: 0,
      });
    },
    [wallet?.address, connect, market, doDeposit],
  );

  const onWithdraw = useCallback(
    (args: ActionArgs) => {
      if (!wallet?.address) {
        connect?.();
        return;
      }
      const raw = BigInt(Math.floor(args.amount * 10 ** market.decimals));
      if (raw <= 0n) return;
      void doWithdraw({
        userEvmAddress: wallet.address as `0x${string}`,
        marketIndex: market.marketIndex,
        mint: market.mintHex,
        spotMarketVault: market.spotMarketVault,
        spotMarketPda: market.spotMarketPda,
        oraclePda: market.oraclePda,
        amount: raw,
        reduceOnly: false,
        subAccountId: 0,
      });
    },
    [wallet?.address, connect, market, doWithdraw],
  );

  return (
    <WrapperGate
      mintBs58={market.mintBs58}
      userAddress={wallet?.address as `0x${string}` | undefined}
      sourceSymbolHint={market.symbol}
    >
      <SpotDrift
        wallet={wallet}
        onConnect={connect}
        market={market}
        ataBalancesByMint={ataBalancesByMint}
        initFlags={initFlags}
        initStatsState={initStatsState}
        initUserState={initUserState}
        depositState={depositState}
        withdrawState={withdrawState}
        onInitStats={onInitStats}
        onInitUser={onInitUser}
        onDeposit={onDeposit}
        onWithdraw={onWithdraw}
      />
    </WrapperGate>
  );
}
