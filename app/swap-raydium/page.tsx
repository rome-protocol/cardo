// Swap-Raydium route `/swap-raydium` — Raydium CPMM swap_base_input on
// devnet using the seeded WSOL/USDC pool. Family 3,
// A1 → A0 promotion via existing devnet liquidity (no auto-clone needed
// — Raydium runs a maintained CPMM deployment on devnet).
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md

'use client';

import { useCallback, useMemo, useState } from 'react';
import { SwapRaydium } from '@/components/screens/SwapRaydium';
import { TxError, TxHash } from '@/components/design/Inline';
import { useWallet } from '../wallet-context';
import { ENABLED_RAYDIUM_CPMM_POOLS } from '@/lib/raydium-cpmm-pools';
import { useRaydiumCpmmPoolState } from '@/lib/use-raydium-cpmm-pool-state';
import { useRaydiumCpmmSwap } from '@/lib/use-raydium-cpmm-swap';
import {
  useRaydiumCpmmDeposit,
  useRaydiumCpmmSwapBaseOutput,
  useRaydiumCpmmWithdraw,
} from '@/lib/use-raydium-cpmm-extensions';
import { useSolanaTokenBalances } from '@/lib/use-solana-balances';
import { activeChain } from '@/lib/chain-config';

type SwapArgs = {
  inputIsToken0: boolean;
  amountIn: bigint;
  minimumAmountOut: bigint;
};

// Rome EVM wrappers for the seeded pool's two SPL mints — registry-driven
// (was stale pre-#240 literals). USDC = chain_mint_id wrapper, WSOL = canonical.
const { wUsdc: WUSDC_WRAPPER, wWsol: WWSOL_WRAPPER } = activeChain().wrappers;

export default function Page() {
  const { wallet, connect } = useWallet();
  const pool = ENABLED_RAYDIUM_CPMM_POOLS[0];
  const poolState = useRaydiumCpmmPoolState(pool?.poolBs58 ?? null);
  const { state: swapState, swap } = useRaydiumCpmmSwap();
  const { state: swapOutState, swap: swapOut } = useRaydiumCpmmSwapBaseOutput();
  const { state: depositState, deposit: cpmmDeposit } = useRaydiumCpmmDeposit();
  const { state: withdrawState, withdraw: cpmmWithdraw } = useRaydiumCpmmWithdraw();
  const [exactOut, setExactOut] = useState('');
  const [maxIn, setMaxIn] = useState('');
  const [lpOut, setLpOut] = useState('');
  const [maxToken0, setMaxToken0] = useState('');
  const [maxToken1, setMaxToken1] = useState('');
  const [lpBurn, setLpBurn] = useState('');

  // Map mint hex → EVM wrapper so useSolanaTokenBalances can read the
  // user's per-mint ATA balance. token_0 = WSOL, token_1 = USDC for the
  // seeded pool — that ordering is encoded in the pool struct, not
  // chosen by us.
  const tokenSpecs = useMemo(
    () =>
      pool
        ? [
            { wrapper: WWSOL_WRAPPER, mintAddress: 'So11111111111111111111111111111111111111112' },
            { wrapper: WUSDC_WRAPPER, mintAddress: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' },
          ]
        : [],
    [pool],
  );
  const balances = useSolanaTokenBalances(
    tokenSpecs,
    wallet?.address as `0x${string}` | undefined,
  );

  const ataBalancesByMint: Record<string, number> = useMemo(() => {
    if (!pool) return {};
    return {
      [pool.token0Mint]:
        Number(balances[WWSOL_WRAPPER] ?? 0n) / 10 ** pool.mint0Decimals,
      [pool.token1Mint]:
        Number(balances[WUSDC_WRAPPER] ?? 0n) / 10 ** pool.mint1Decimals,
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
        inputIsToken0: args.inputIsToken0,
        amountIn: args.amountIn,
        minimumAmountOut: args.minimumAmountOut,
      });
    },
    [wallet?.address, connect, pool, swap],
  );

  const onSwapOut = useCallback(() => {
    if (!wallet?.address || !pool) return;
    const out = parseFloat(exactOut) || 0;
    const inMax = parseFloat(maxIn) || 0;
    if (out <= 0 || inMax <= 0) return;
    // Default: spending token_0 (WSOL) to receive exact token_1 (USDC).
    const outRaw = BigInt(Math.floor(out * 10 ** pool.mint1Decimals));
    const inMaxRaw = BigInt(Math.floor(inMax * 10 ** pool.mint0Decimals));
    void swapOut({
      userEvmAddress: wallet.address as `0x${string}`,
      pool,
      inputIsToken0: true,
      maxAmountIn: inMaxRaw,
      amountOut: outRaw,
    });
  }, [wallet?.address, pool, exactOut, maxIn, swapOut]);

  const onDepositLp = useCallback(() => {
    if (!wallet?.address || !pool) return;
    const lp = parseFloat(lpOut) || 0;
    const t0 = parseFloat(maxToken0) || 0;
    const t1 = parseFloat(maxToken1) || 0;
    if (lp <= 0 || t0 <= 0 || t1 <= 0) return;
    void cpmmDeposit({
      userEvmAddress: wallet.address as `0x${string}`,
      pool,
      lpTokenAmount: BigInt(Math.floor(lp * 1_000_000_000)),
      maximumToken0Amount: BigInt(Math.floor(t0 * 10 ** pool.mint0Decimals)),
      maximumToken1Amount: BigInt(Math.floor(t1 * 10 ** pool.mint1Decimals)),
    });
  }, [wallet?.address, pool, lpOut, maxToken0, maxToken1, cpmmDeposit]);

  const onWithdrawLp = useCallback(() => {
    if (!wallet?.address || !pool) return;
    const lp = parseFloat(lpBurn) || 0;
    if (lp <= 0) return;
    void cpmmWithdraw({
      userEvmAddress: wallet.address as `0x${string}`,
      pool,
      lpTokenAmount: BigInt(Math.floor(lp * 1_000_000_000)),
      minimumToken0Amount: 0n,
      minimumToken1Amount: 0n,
    });
  }, [wallet?.address, pool, lpBurn, cpmmWithdraw]);

  return (
    <>
      <SwapRaydium
        wallet={wallet}
        onConnect={connect}
        pool={pool}
        poolState={poolState}
        ataBalancesByMint={ataBalancesByMint}
        onSwap={onSwap}
        swapState={swapState}
      />

      {wallet?.connected && pool && (
        <main className="container" style={{ padding: '0 32px 96px' }}>
          <div style={{ maxWidth: 600 }}>
            <div className="tiny" style={{ textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--fg2)', marginBottom: 8 }}>
              Exact-output swap
            </div>
            <p className="small" style={{ marginTop: 0, marginBottom: 18, color: 'var(--fg2)' }}>
              Spend up to <span className="mono">max_amount_in</span> WSOL to receive
              exactly <span className="mono">amount_out</span> USDC. Verified via
              <span className="mono"> cp-swap::swap_base_output</span>.
            </p>
            <div className="card" style={{ padding: 24, marginBottom: 14 }}>
              <div style={{ marginBottom: 12 }}>
                <div className="small" style={{ marginBottom: 6, color: 'var(--fg2)' }}>Exact USDC out</div>
                <input type="number" inputMode="decimal" placeholder="0.00" value={exactOut} onChange={(e) => setExactOut(e.target.value)} style={inputStyle()} />
              </div>
              <div style={{ marginBottom: 12 }}>
                <div className="small" style={{ marginBottom: 6, color: 'var(--fg2)' }}>Max WSOL to spend</div>
                <input type="number" inputMode="decimal" placeholder="0.00" value={maxIn} onChange={(e) => setMaxIn(e.target.value)} style={inputStyle()} />
              </div>
              <button
                className="btn"
                disabled={!exactOut || !maxIn || swapOutState.phase === 'signing' || swapOutState.phase === 'confirming'}
                onClick={onSwapOut}
                style={{ width: '100%', opacity: (!exactOut || !maxIn) ? 0.5 : 1 }}
              >
                {swapOutState.phase === 'signing' && 'Awaiting signature…'}
                {swapOutState.phase === 'confirming' && 'Confirming on Solana…'}
                {swapOutState.phase === 'success' && 'Exact-out swap ✓'}
                {swapOutState.phase === 'failed' && 'swap_base_output failed'}
                {swapOutState.phase === 'idle' && 'Swap with exact output'}
              </button>
              {swapOutState.phase === 'failed' && swapOutState.error && (
                <div className="small" style={{ marginTop: 8 }}><TxError error={swapOutState.error} /></div>
              )}
              {(swapOutState.phase === 'confirming' || swapOutState.phase === 'success') && swapOutState.hash && (
                <div className="small" style={{ marginTop: 8 }}>tx <TxHash hash={swapOutState.hash} /></div>
              )}
            </div>

            <div className="tiny" style={{ textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--fg2)', marginBottom: 8 }}>
              Liquidity provision
            </div>
            <p className="small" style={{ marginTop: 0, marginBottom: 18, color: 'var(--fg2)' }}>
              Adds or removes liquidity on the seeded WSOL/USDC pool. Verified via
              <span className="mono"> cp-swap::deposit / withdraw</span>.
            </p>

            <div className="card" style={{ padding: 24, marginBottom: 14 }}>
              <div className="serif" style={{ fontSize: 17, marginBottom: 12 }}>Add liquidity</div>
              <div style={{ marginBottom: 12 }}>
                <div className="small" style={{ marginBottom: 6, color: 'var(--fg2)' }}>LP tokens to receive</div>
                <input type="number" inputMode="decimal" placeholder="0.00" value={lpOut} onChange={(e) => setLpOut(e.target.value)} style={inputStyle()} />
              </div>
              <div style={{ marginBottom: 12 }}>
                <div className="small" style={{ marginBottom: 6, color: 'var(--fg2)' }}>Max WSOL to spend</div>
                <input type="number" inputMode="decimal" placeholder="0.00" value={maxToken0} onChange={(e) => setMaxToken0(e.target.value)} style={inputStyle()} />
              </div>
              <div style={{ marginBottom: 12 }}>
                <div className="small" style={{ marginBottom: 6, color: 'var(--fg2)' }}>Max USDC to spend</div>
                <input type="number" inputMode="decimal" placeholder="0.00" value={maxToken1} onChange={(e) => setMaxToken1(e.target.value)} style={inputStyle()} />
              </div>
              <button
                className="btn btn-primary"
                disabled={!lpOut || !maxToken0 || !maxToken1 || depositState.phase === 'signing' || depositState.phase === 'confirming'}
                onClick={onDepositLp}
                style={{ width: '100%', opacity: (!lpOut || !maxToken0 || !maxToken1) ? 0.5 : 1 }}
              >
                {depositState.phase === 'signing' && 'Awaiting signature…'}
                {depositState.phase === 'confirming' && 'Confirming on Solana…'}
                {depositState.phase === 'success' && 'LP minted ✓'}
                {depositState.phase === 'failed' && 'Deposit failed'}
                {depositState.phase === 'idle' && 'Deposit liquidity'}
              </button>
              {depositState.phase === 'failed' && depositState.error && (
                <div className="small" style={{ marginTop: 8 }}><TxError error={depositState.error} /></div>
              )}
              {(depositState.phase === 'confirming' || depositState.phase === 'success') && depositState.hash && (
                <div className="small" style={{ marginTop: 8 }}>tx <TxHash hash={depositState.hash} /></div>
              )}
            </div>

            <div className="card" style={{ padding: 24 }}>
              <div className="serif" style={{ fontSize: 17, marginBottom: 12 }}>Remove liquidity</div>
              <div style={{ marginBottom: 12 }}>
                <div className="small" style={{ marginBottom: 6, color: 'var(--fg2)' }}>LP tokens to burn</div>
                <input type="number" inputMode="decimal" placeholder="0.00" value={lpBurn} onChange={(e) => setLpBurn(e.target.value)} style={inputStyle()} />
              </div>
              <button
                className="btn"
                disabled={!lpBurn || withdrawState.phase === 'signing' || withdrawState.phase === 'confirming'}
                onClick={onWithdrawLp}
                style={{ width: '100%', opacity: !lpBurn ? 0.5 : 1 }}
              >
                {withdrawState.phase === 'signing' && 'Awaiting signature…'}
                {withdrawState.phase === 'confirming' && 'Confirming on Solana…'}
                {withdrawState.phase === 'success' && 'LP burned ✓'}
                {withdrawState.phase === 'failed' && 'Withdraw failed'}
                {withdrawState.phase === 'idle' && 'Withdraw liquidity'}
              </button>
              {withdrawState.phase === 'failed' && withdrawState.error && (
                <div className="small" style={{ marginTop: 8 }}><TxError error={withdrawState.error} /></div>
              )}
              {(withdrawState.phase === 'confirming' || withdrawState.phase === 'success') && withdrawState.hash && (
                <div className="small" style={{ marginTop: 8 }}>tx <TxHash hash={withdrawState.hash} /></div>
              )}
            </div>
          </div>
        </main>
      )}
    </>
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
