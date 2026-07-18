'use client';
// SwapRaydiumClmm screen — act|see redesign. Swap WSOL ↔ USDC through
// Raydium CLMM swap_v2 on devnet, from one EVM wallet.
//
// CLMM-specific invariants preserved from the previous screen:
//   - Quote uses Q64.64 sqrtPrice single-step (concentrated liquidity,
//     constant-liquidity within the current tick array). NOT x*y=k.
//   - Swap-disabled gate: bit 4 (mask 0x10) of poolState.pool.status.
//   - Pool fee badge: trade_fee_rate from AmmConfig (5 bps for HXAQnU2).
//   - CLMM can revert if the swap crosses an uninitialized tick array;
//     tick handling is unchanged from the original screen.
//   - onSwap shape: { inputIsToken0: boolean, amountIn: bigint, minimumAmountOut: bigint }
//
// Pool: token_0 = WSOL (9 dec), token_1 = USDC (6 dec).
// USD anchor: USDC leg (one side is always USDC, so both legs read at $1).

import React, { useEffect, useMemo, useState } from 'react';
import { fmtUSD, fmtNum } from '../primitives';
import { Ledger } from '../design/Ledger';
import { TxHash } from '../design/Inline';
import { useSignaturePlan } from '../../lib/use-signature-plan';
import { quoteRaydiumClmmSwapSingleStep } from '@/lib/raydium-clmm-pools';
import { signaturePlan } from '../../lib/signature-plan';
import { compactNum } from '../../lib/stats-format';
import s from '../design/actsee.module.css';

const SLIPPAGE_BPS = 200; // 2.00% — matches original; thin devnet pools need headroom.

export function SwapRaydiumClmm({
  wallet,
  onConnect,
  pool,
  poolState,
  ataBalancesByMint = {},
  onSwap,
  swapState,
}) {
  const [direction, setDirection] = useState('zero_to_one');
  const [amount, setAmount] = useState('');

  const inputIsToken0 = direction === 'zero_to_one';

  // Symbols are display-only; derive from decimals (9 → WSOL, 6 → USDC).
  const sym0 = pool?.mint0Decimals === 9 ? 'WSOL' : pool?.mint0Decimals === 6 ? 'USDC' : 'token0';
  const sym1 = pool?.mint1Decimals === 9 ? 'WSOL' : pool?.mint1Decimals === 6 ? 'USDC' : 'token1';

  const inSym = inputIsToken0 ? sym0 : sym1;
  const outSym = inputIsToken0 ? sym1 : sym0;
  const inMint = inputIsToken0 ? pool?.token0Mint : pool?.token1Mint;
  const outMint = inputIsToken0 ? pool?.token1Mint : pool?.token0Mint;
  const inDecimals = inputIsToken0 ? pool?.mint0Decimals : pool?.mint1Decimals;
  const outDecimals = inputIsToken0 ? pool?.mint1Decimals : pool?.mint0Decimals;
  const inBalance = inMint ? (ataBalancesByMint[inMint] ?? 0) : 0;
  const outBalance = outMint ? (ataBalancesByMint[outMint] ?? 0) : 0;

  const amt = parseFloat(amount) || 0;
  const insufficient = amt > 0 && amt > inBalance;
  const phase = swapState?.phase ?? 'idle';
  const isWorking = phase === 'signing' || phase === 'confirming';

  // Effective vault reserves — used for the thin-pool warning only.
  // The swap math itself uses sqrtPrice + liquidity, not vault balances.
  const outputEff = inputIsToken0 ? poolState?.token1EffectiveReserve : poolState?.token0EffectiveReserve;
  const outputEffHuman =
    outputEff != null && outDecimals != null
      ? Number(outputEff) / 10 ** outDecimals
      : null;
  const thinPool = outputEffHuman != null && outputEffHuman < 1;

  // Pool liquidity (fixed token0/token1 order — independent of swap direction).
  // Effective vault reserves when available; fall back to raw.
  const reserve0Raw = poolState?.token0EffectiveReserve ?? poolState?.token0Reserve;
  const reserve1Raw = poolState?.token1EffectiveReserve ?? poolState?.token1Reserve;
  const liq0Human =
    reserve0Raw != null && pool?.mint0Decimals != null
      ? Number(reserve0Raw) / 10 ** pool.mint0Decimals
      : null;
  const liq1Human =
    reserve1Raw != null && pool?.mint1Decimals != null
      ? Number(reserve1Raw) / 10 ** pool.mint1Decimals
      : null;

  // Live indicative quote — CLMM Q64.64 single-step.
  const quote = useMemo(() => {
    if (
      !pool ||
      !poolState?.pool ||
      poolState.tradeFeeRatePpm == null ||
      amt <= 0 ||
      inDecimals == null ||
      outDecimals == null
    ) {
      return null;
    }
    const liquidity = poolState.pool.liquidity;
    const sqrtPriceX64 = poolState.pool.sqrtPriceX64;
    if (liquidity <= 0n || sqrtPriceX64 <= 0n) return null;

    const amountIn = BigInt(Math.floor(amt * 10 ** inDecimals));
    if (amountIn <= 0n) return null;

    const out = quoteRaydiumClmmSwapSingleStep({
      liquidity,
      sqrtPriceX64,
      amountIn,
      feeRatePpm: poolState.tradeFeeRatePpm,
      zeroForOne: inputIsToken0,
    });
    return { amountIn, amountOut: out, human: Number(out) / 10 ** outDecimals };
  }, [pool, poolState, amt, inputIsToken0, inDecimals, outDecimals]);

  const noLiquidity = poolState?.pool != null && poolState.pool.liquidity <= 0n;

  // status bit flags on CLMM:
  //   bit4 = SWAP disabled (mask 0x10 = 16) — gate on this only.
  const swapDisabled = pool && (((poolState?.pool?.status ?? 0) >> 4) & 1) === 1;

  const minOutRaw = quote ? (quote.amountOut * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n : 0n;
  const minOutHuman = quote && outDecimals != null ? Number(minOutRaw) / 10 ** outDecimals : 0;
  const rate = amt > 0 && quote && quote.human > 0 ? quote.human / amt : 0;

  // USD anchor: the USDC leg is always $1, so usdValue = USDC amount regardless of direction.
  // token_0 = WSOL, token_1 = USDC → when inputIsToken0 the output is USDC, else input is USDC.
  const usdValue = inputIsToken0 ? (quote?.human ?? 0) : amt;

  const FEE_PPM = poolState?.tradeFeeRatePpm ?? 0;
  const FEE_BPS = Number(FEE_PPM) / 100;
  const liveFee = usdValue * (Number(FEE_PPM) / 1_000_000);
  const liveGas = 0.008;
  const liveTotal = liveFee + liveGas;

  // Signature plan — reuse the 'swap' flow (ATA probe for the receive token).
  // We pass outAtaExists: undefined — we don't probe the Raydium ATA separately;
  // the optimistic path (undefined → assume exists) is correct here.
  const rawPlan = useSignaturePlan({
    flow: 'swap',
    userEvmAddress: wallet?.connected && wallet?.address ? wallet.address : undefined,
    outMintHex: undefined,
  });
  // Relabel the core action step for Raydium CLMM.
  const steps = signaturePlan('swap', { outAtaExists: undefined }).map((st) =>
    st.id === 'swap'
      ? { ...st, label: 'Swap on Raydium CLMM', detail: 'CPI → Raydium CLMM swap' }
      : st,
  );
  const plan = { ...rawPlan, steps, count: steps.length };

  const submitDisabled =
    !wallet?.connected ||
    !pool ||
    noLiquidity ||
    !!swapDisabled ||
    amt <= 0 ||
    insufficient ||
    isWorking ||
    !quote ||
    quote.amountOut <= 0n;

  // Reset amount when direction flips (balance context changes).
  useEffect(() => {
    setAmount('');
  }, [direction]);

  // CTA label and caption.
  let ctaLabel = `Swap ${inSym} → ${outSym}`;
  let ctaCaption = '1 signature · settles atomically on Solana';
  let ctaDisabled = submitDisabled;
  let ctaOnClick = () => {
    if (!quote) return;
    onSwap?.({ inputIsToken0, amountIn: quote.amountIn, minimumAmountOut: minOutRaw });
  };

  if (!wallet?.connected) {
    ctaLabel = 'Connect wallet';
    ctaCaption = 'one wallet — no bridge, no Phantom';
    ctaDisabled = false;
    ctaOnClick = onConnect ?? (() => {});
  } else if (!pool || poolState?.loading) {
    ctaLabel = 'Loading pool…';
    ctaDisabled = true;
    ctaOnClick = () => {};
  } else if (noLiquidity) {
    ctaLabel = 'No liquidity in pool';
    ctaDisabled = true;
    ctaOnClick = () => {};
  } else if (swapDisabled) {
    ctaLabel = 'Swaps disabled on this pool';
    ctaDisabled = true;
    ctaOnClick = () => {};
  } else if (isWorking) {
    ctaLabel = phase === 'signing' ? 'Confirm in MetaMask…' : 'Settling on Solana…';
    ctaDisabled = true;
    ctaOnClick = () => {};
  } else if (insufficient) {
    ctaLabel = `Insufficient ${inSym}`;
    ctaDisabled = true;
    ctaOnClick = () => {};
  }

  // Status line (SEE column).
  let statusNode = <>Preview · this is exactly what your wallet will sign</>;
  if (swapState?.phase === 'signing') {
    statusNode = <>Confirm in MetaMask…</>;
  } else if (swapState?.phase === 'confirming') {
    statusNode = <>Settling on Solana…</>;
  } else if (swapState?.phase === 'success') {
    statusNode = (
      <>
        <span className={s.ok}>&#10003; Settled on Raydium CLMM</span>
        {swapState?.hash ? <> · <TxHash hash={swapState.hash} /></> : null}
      </>
    );
  } else if (swapState?.phase === 'failed') {
    statusNode = <span className={s.bad}>Reverted · try again</span>;
  }

  // Token icon class: WSOL → s.sol, USDC → s.usdc, other → s.gen
  const icFor = (sym) =>
    sym === 'WSOL' ? s.sol : sym === 'USDC' ? s.usdc : s.gen;
  const icIn = icFor(inSym);
  const icOut = icFor(outSym);

  return (
    <main className={s.work}>
      <div className={s.strip}>
        <div className={s.lead}>
          <span className={s.eyebrow}>Raydium CLMM · concentrated liquidity</span>
          <h1>
            Swap on Raydium from your EVM wallet — <em>one wallet, no bridge</em>.
          </h1>
        </div>
        <span className={s.routepill}>
          <span className={`${s.dot} ${s.evm}`} /> EVM · Rome <span className={s.ar}>→</span> Raydium{' '}
          <span className={`${s.dot} ${s.sol}`} />
        </span>
      </div>

      <div className={s.rig}>
        {/* ── ACT ── */}
        <form
          className={`${s.col} ${s.act}`}
          autoComplete="off"
          onSubmit={(e) => {
            e.preventDefault();
            ctaOnClick();
          }}
        >
          <div className={s.colhd}>
            <span className={s.sd} /> You do this
          </div>

          <div className={s.leg}>
            <div className={s.r1}>
              <label>You pay</label>
              <span className={s.bal}>
                balance <b>{fmtNum(inBalance, 4)}</b> {inSym}
              </span>
            </div>
            <div className={s.r2}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <input
                  className={s.amt}
                  inputMode="decimal"
                  aria-label="Pay amount"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
                <div className={s.usd}>≈ {fmtUSD(usdValue)}</div>
              </div>
              <div className={s.tokchip}>
                <span className={`${s.ic} ${icIn}`}>{inSym.charAt(0).toLowerCase()}</span>
                <span className={s.sym}>{inSym}</span>
              </div>
            </div>
            <div className={s.pct}>
              {[25, 50, 100].map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() =>
                    setAmount(((inBalance * p) / 100).toFixed(6).replace(/\.?0+$/, ''))
                  }
                >
                  {p === 100 ? 'Max' : `${p}%`}
                </button>
              ))}
            </div>
          </div>

          <div className={s.flipwrap}>
            <button
              type="button"
              className={s.flip}
              aria-label="Flip direction"
              onClick={() => setDirection((d) => (d === 'zero_to_one' ? 'one_to_zero' : 'zero_to_one'))}
            >
              &#8645;
            </button>
          </div>

          <div className={s.leg}>
            <div className={s.r1}>
              <label>You receive</label>
              <span className={s.bal}>
                balance <b>{fmtNum(outBalance, 4)}</b> {outSym}
              </span>
            </div>
            <div className={s.r2}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className={`${s.amt} ${s.out}`}>
                  {quote && quote.human > 0 ? fmtNum(quote.human, 6) : '0.00'}
                </div>
                <div className={s.usd}>≈ {fmtUSD(usdValue)}</div>
              </div>
              <div className={s.tokchip}>
                <span className={`${s.ic} ${icOut}`}>{outSym.charAt(0).toLowerCase()}</span>
                <span className={s.sym}>{outSym}</span>
              </div>
            </div>
          </div>

          {/* Direction toggle (replaces the old btn-pair) */}
          <div className={s.slip}>
            <span className={s.lbl}>Direction</span>
            <button
              type="button"
              aria-pressed={inputIsToken0}
              onClick={() => setDirection('zero_to_one')}
            >
              {sym0} → {sym1}
            </button>
            <button
              type="button"
              aria-pressed={!inputIsToken0}
              onClick={() => setDirection('one_to_zero')}
            >
              {sym1} → {sym0}
            </button>
          </div>

          {thinPool && (
            <div className={s.slip} style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--bad)' }}>
                Thin-pool warning
              </span>
              <span style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.5 }}>
                Only <b>{fmtNum(outputEffHuman ?? 0, 6)} {outSym}</b> of swappable reserve.
                Small swaps may revert with PriceSlippageCheck.
              </span>
            </div>
          )}

          <div className={s['cta-wrap']}>
            <button
              className={s.cta}
              type="submit"
              disabled={ctaDisabled}
            >
              <span>{ctaLabel}</span>
              <span className={s.sig}>{ctaCaption}</span>
            </button>
          </div>
        </form>

        {/* ── SEE ── */}
        <section className={`${s.col} ${s.see}`}>
          <div className={s.colhd}>
            <span className={s.sd} /> What will happen
            <span className={s.pool}>Raydium CLMM · {FEE_BPS > 0 ? `${FEE_BPS} bps` : 'CL'}</span>
          </div>
          <div className={s.body}>
            <Ledger
              steps={plan.steps}
              count={plan.count}
              loading={plan.loading}
              sub={
                <>
                  One wallet — <b>no bridge, no Phantom, no second account</b>. Routes through
                  Raydium&apos;s concentrated-liquidity pool on Solana.
                </>
              }
            />
            <div className={s.outcome}>
              <div className={`${s.ln} ${s.get}`}>
                <span className={s.k}>You receive at least</span>
                <span className={s.v}>
                  {minOutHuman > 0 ? fmtNum(minOutHuman, 6) : '—'} {outSym}
                </span>
              </div>
              <div className={s.ln}>
                <span className={s.k}>Rate</span>
                <span className={s.v}>
                  {rate > 0 ? `1 ${inSym} = ${fmtNum(rate, 6)} ${outSym}` : '—'}
                </span>
              </div>
              <div className={s.ln}>
                <span className={s.k}>Pool liquidity</span>
                <span className={s.v}>
                  {liq0Human != null ? `${compactNum(liq0Human)} ${sym0}` : '—'} · {liq1Human != null ? `${compactNum(liq1Human)} ${sym1}` : '—'}
                </span>
              </div>
              <div className={s.ln}>
                <span className={s.k}>
                  Pool fee{FEE_BPS > 0 && <small>{FEE_BPS} bps</small>}
                </span>
                <span className={s.v}>{liveFee > 0 ? fmtUSD(liveFee) : '—'}</span>
              </div>
              <div className={s.ln}>
                <span className={s.k}>EVM gas · Rome</span>
                <span className={s.v}>{fmtUSD(liveGas, { decimals: 3 })}</span>
              </div>
              <div className={s.ln}>
                <span className={s.k}>Total cost</span>
                <span className={s.v}>{fmtUSD(liveTotal, { decimals: 3 })}</span>
              </div>
              <div className={s.note}>
                The trade and your balance change land <b>together, or neither</b> — one
                atomic Rome transaction at the pool&apos;s live price.{' '}
                {thinPool && (
                  <>Thin devnet pool: swaps may revert if they cross an uninitialized tick array.</>
                )}
              </div>
            </div>
          </div>
          <div className={s.status}>{statusNode}</div>
        </section>
      </div>
    </main>
  );
}
