// Swap-PumpSwap route `/swap-pumpswap` — PumpSwap AMM buy/sell on
// devnet using an existing funded WSOL/memecoin pool.
//
// A6 / A0 promotion. Adapter library: lib/pumpswap-*. Active pool +
// token wrapper config: lib/pumpswap-pool-config.ts.
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md

'use client';

import { useCallback, useMemo, useState } from 'react';
import { SwapPumpswap } from '@/components/screens/SwapPumpswap';
import { TxError, TxHash } from '@/components/design/Inline';
import { WrapperGate } from '@/components/WrapperGate';
import { useWallet } from '../wallet-context';
import { pumpswapActivePool } from '@/lib/pumpswap-pool-config';
import { usePumpswapPoolState } from '@/lib/use-pumpswap-pool-state';
import { usePumpswapSwap } from '@/lib/use-pumpswap-swap';
import {
  usePumpSwapDeposit,
  usePumpSwapWithdraw,
} from '@/lib/use-pumpswap-lp';
import { useSolanaTokenBalances } from '@/lib/use-solana-balances';

type SwapArgs = {
  side: 'buy' | 'sell';
  amountHuman: number;
  quotedOutRaw: bigint;
  quotedOutHuman: number;
  slippageBps: number;
};

export default function Page() {
  const { wallet, connect } = useWallet();
  const pool = pumpswapActivePool();
  const poolState = usePumpswapPoolState(pool.poolBs58);
  const { state: swapState, swap } = usePumpswapSwap();
  const { state: depositState, deposit } = usePumpSwapDeposit();
  const { state: withdrawState, withdraw } = usePumpSwapWithdraw();
  const [lpAmount, setLpAmount] = useState('');
  const [maxBaseIn, setMaxBaseIn] = useState('');
  const [maxQuoteIn, setMaxQuoteIn] = useState('');
  const [withdrawLp, setWithdrawLp] = useState('');

  // Read user's base + quote ATA balances on Solana so the form knows
  // what's spendable. Keyed by EVM wrapper address; the screen also
  // needs them keyed by mint bs58.
  const tokenSpecs = useMemo(
    () => [
      { wrapper: pool.base.wrapper, mintAddress: pool.base.mintBs58 },
      { wrapper: pool.quote.wrapper, mintAddress: pool.quote.mintBs58 },
    ],
    [pool],
  );
  const balances = useSolanaTokenBalances(
    tokenSpecs,
    wallet?.address as `0x${string}` | undefined,
  );
  const ataBalancesByMint: Record<string, number> = useMemo(() => {
    const baseRaw = balances[pool.base.wrapper.toLowerCase()] ?? 0n;
    const quoteRaw = balances[pool.quote.wrapper.toLowerCase()] ?? 0n;
    return {
      [pool.base.mintBs58]: Number(baseRaw) / 10 ** pool.base.decimals,
      [pool.quote.mintBs58]: Number(quoteRaw) / 10 ** pool.quote.decimals,
    };
  }, [balances, pool]);

  const onSwap = useCallback(
    (args: SwapArgs) => {
      if (!wallet?.address) {
        connect?.();
        return;
      }
      if (!poolState.pool) return;

      const slipMul = BigInt(10_000 - args.slippageBps);
      const slipDenom = 10_000n;

      if (args.side === 'buy') {
        // Buy: spend up to maxQuoteAmountIn, want at least baseAmountOut.
        const maxQuoteAmountIn = BigInt(
          Math.floor(args.amountHuman * 10 ** pool.quote.decimals),
        );
        const baseAmountOut =
          (args.quotedOutRaw * slipMul) / slipDenom;
        if (maxQuoteAmountIn <= 0n || baseAmountOut <= 0n) return;
        void swap({
          side: 'buy',
          userEvmAddress: wallet.address as `0x${string}`,
          pool: poolState.pool,
          poolPubkey: pool.poolBs58,
          baseAmountOut,
          maxQuoteAmountIn,
          trackVolume: true,
        });
      } else {
        // Sell: spend baseAmountIn, want at least minQuoteAmountOut.
        const baseAmountIn = BigInt(
          Math.floor(args.amountHuman * 10 ** pool.base.decimals),
        );
        const minQuoteAmountOut =
          (args.quotedOutRaw * slipMul) / slipDenom;
        if (baseAmountIn <= 0n) return;
        void swap({
          side: 'sell',
          userEvmAddress: wallet.address as `0x${string}`,
          pool: poolState.pool,
          poolPubkey: pool.poolBs58,
          baseAmountIn,
          minQuoteAmountOut,
        });
      }
    },
    [wallet?.address, connect, poolState.pool, pool, swap],
  );

  const onDepositLp = useCallback(() => {
    if (!wallet?.address) {
      connect?.();
      return;
    }
    if (!poolState.pool) return;
    const lpOut = parseFloat(lpAmount) || 0;
    const baseIn = parseFloat(maxBaseIn) || 0;
    const quoteIn = parseFloat(maxQuoteIn) || 0;
    if (lpOut <= 0 || baseIn <= 0 || quoteIn <= 0) return;
    // LP mint is typically 9 decimals (PumpSwap convention).
    const lpRaw = BigInt(Math.floor(lpOut * 1_000_000_000));
    const baseRaw = BigInt(Math.floor(baseIn * 10 ** pool.base.decimals));
    const quoteRaw = BigInt(Math.floor(quoteIn * 10 ** pool.quote.decimals));
    void deposit({
      userEvmAddress: wallet.address as `0x${string}`,
      pool: poolState.pool,
      poolPubkey: pool.poolBs58,
      lpTokenAmountOut: lpRaw,
      maxBaseAmountIn: baseRaw,
      maxQuoteAmountIn: quoteRaw,
    });
  }, [wallet?.address, connect, poolState.pool, pool, deposit, lpAmount, maxBaseIn, maxQuoteIn]);

  const onWithdrawLp = useCallback(() => {
    if (!wallet?.address) {
      connect?.();
      return;
    }
    if (!poolState.pool) return;
    const lpIn = parseFloat(withdrawLp) || 0;
    if (lpIn <= 0) return;
    const lpRaw = BigInt(Math.floor(lpIn * 1_000_000_000));
    void withdraw({
      userEvmAddress: wallet.address as `0x${string}`,
      pool: poolState.pool,
      poolPubkey: pool.poolBs58,
      lpTokenAmountIn: lpRaw,
      // 1% slippage floor on both sides — caller can tighten by editing.
      minBaseAmountOut: 0n,
      minQuoteAmountOut: 0n,
    });
  }, [wallet?.address, connect, poolState.pool, pool, withdraw, withdrawLp]);

  return (
    <WrapperGate
      mintBs58={pool.base.mintBs58}
      userAddress={wallet?.address as `0x${string}` | undefined}
      sourceSymbolHint="MEME"
    >
      <SwapPumpswap
        wallet={wallet}
        onConnect={connect}
        pool={pool}
        poolState={poolState}
        ataBalancesByMint={ataBalancesByMint}
        onSwap={onSwap}
        swapState={swapState}
      />

      {wallet?.connected && (
        <main className="container" style={{ padding: '0 32px 96px' }}>
          <div style={{ maxWidth: 600 }}>
            <div className="tiny" style={{ textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--fg2)', marginBottom: 8 }}>
              Liquidity provision
            </div>
            <p className="small" style={{ marginTop: 0, marginBottom: 18, color: 'var(--fg2)' }}>
              Add or remove liquidity on the pinned PumpSwap pool. Deposit
              mints LP tokens; withdraw burns them. Verified via{' '}
              <span className="mono">pump_amm::deposit</span> +
              <span className="mono"> pump_amm::withdraw</span> (15 accts each).
            </p>
            <div className="card" style={{ padding: 24, marginBottom: 14 }}>
              <div className="serif" style={{ fontSize: 17, marginBottom: 12 }}>Add liquidity</div>
              <div style={{ marginBottom: 12 }}>
                <div className="small" style={{ marginBottom: 6, color: 'var(--fg2)' }}>LP tokens to receive (out)</div>
                <input type="number" inputMode="decimal" placeholder="0.00" value={lpAmount} onChange={(e) => setLpAmount(e.target.value)} style={inputStyle()} />
              </div>
              <div style={{ marginBottom: 12 }}>
                <div className="small" style={{ marginBottom: 6, color: 'var(--fg2)' }}>Max {pool.base.symbol} to spend</div>
                <input type="number" inputMode="decimal" placeholder="0.00" value={maxBaseIn} onChange={(e) => setMaxBaseIn(e.target.value)} style={inputStyle()} />
              </div>
              <div style={{ marginBottom: 12 }}>
                <div className="small" style={{ marginBottom: 6, color: 'var(--fg2)' }}>Max {pool.quote.symbol} to spend</div>
                <input type="number" inputMode="decimal" placeholder="0.00" value={maxQuoteIn} onChange={(e) => setMaxQuoteIn(e.target.value)} style={inputStyle()} />
              </div>
              <button
                className="btn btn-primary"
                disabled={depositState.phase === 'signing' || depositState.phase === 'confirming' || !lpAmount || !maxBaseIn || !maxQuoteIn}
                onClick={onDepositLp}
                style={{ width: '100%', opacity: (!lpAmount || !maxBaseIn || !maxQuoteIn) ? 0.5 : 1 }}
              >
                {depositState.phase === 'signing' && 'Awaiting signature…'}
                {depositState.phase === 'confirming' && 'Confirming on Solana…'}
                {depositState.phase === 'success' && 'LP minted ✓'}
                {depositState.phase === 'failed' && 'Deposit failed — try again'}
                {depositState.phase === 'idle' && 'Deposit liquidity'}
              </button>
              {depositState.phase === 'failed' && depositState.error && (
                <div className="small" style={{ marginTop: 8 }}><TxError error={depositState.error} /></div>
              )}
              {(depositState.phase === 'confirming' || depositState.phase === 'success') && depositState.hash && (
                <div className="small" style={{ marginTop: 8 }}>deposit tx <TxHash hash={depositState.hash} /></div>
              )}
            </div>

            <div className="card" style={{ padding: 24 }}>
              <div className="serif" style={{ fontSize: 17, marginBottom: 12 }}>Remove liquidity</div>
              <div style={{ marginBottom: 12 }}>
                <div className="small" style={{ marginBottom: 6, color: 'var(--fg2)' }}>LP tokens to burn</div>
                <input type="number" inputMode="decimal" placeholder="0.00" value={withdrawLp} onChange={(e) => setWithdrawLp(e.target.value)} style={inputStyle()} />
              </div>
              <button
                className="btn"
                disabled={withdrawState.phase === 'signing' || withdrawState.phase === 'confirming' || !withdrawLp}
                onClick={onWithdrawLp}
                style={{ width: '100%', opacity: !withdrawLp ? 0.5 : 1 }}
              >
                {withdrawState.phase === 'signing' && 'Awaiting signature…'}
                {withdrawState.phase === 'confirming' && 'Confirming on Solana…'}
                {withdrawState.phase === 'success' && 'LP burned ✓'}
                {withdrawState.phase === 'failed' && 'Withdraw failed — try again'}
                {withdrawState.phase === 'idle' && 'Withdraw liquidity'}
              </button>
              {withdrawState.phase === 'failed' && withdrawState.error && (
                <div className="small" style={{ marginTop: 8 }}><TxError error={withdrawState.error} /></div>
              )}
              {(withdrawState.phase === 'confirming' || withdrawState.phase === 'success') && withdrawState.hash && (
                <div className="small" style={{ marginTop: 8 }}>withdraw tx <TxHash hash={withdrawState.hash} /></div>
              )}
            </div>
          </div>
        </main>
      )}
    </WrapperGate>
  );
}

const inputStyle = () => ({
  width: '100%',
  padding: 12,
  fontSize: 15,
  background: 'var(--bg-base)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 10,
  color: 'var(--fg1)',
  fontFamily: 'var(--font-mono)',
});
