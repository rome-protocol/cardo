'use client';
// SwapRaydium screen — act|see redesign. Swap WSOL ↔ USDC through the
// Raydium CPMM (constant-product) pool on Solana, from one EVM wallet.
// Left: the trade form. Right: the live signature ledger.
//
// Quote: constant-product (x*y=k) using the pool's effective reserves +
// Raydium's ceil-rounded trade-fee deduction. minOut enforced via SLIPPAGE_BPS
// before calling onSwap.
//
// Pool convention: token_0 = WSOL (9 dec), token_1 = USDC (6 dec).
// USD value anchors to the USDC leg (reliably $1) on both directions.

import React, { useEffect, useMemo, useState } from 'react';
import { fmtUSD, fmtNum } from '../primitives';
import { Ledger } from '../design/Ledger';
import { TxHash } from '../design/Inline';
import { signaturePlan } from '../../lib/signature-plan';
import { compactNum } from '../../lib/stats-format';
import s from '../design/actsee.module.css';

const SLIPPAGE_BPS = 200; // 2.00 % default

export function SwapRaydium({
  wallet,
  onConnect,
  pool,
  poolState,
  ataBalancesByMint = {},
  onSwap,
  swapState,
}) {
  // inputIsToken0: true → WSOL → USDC, false → USDC → WSOL
  const [inputIsToken0, setInputIsToken0] = useState(true);
  const [amount, setAmount] = useState('');

  // Derive symbols from decimals (registry doesn't store display names).
  const sym0 = pool?.mint0Decimals === 9 ? 'WSOL' : pool?.mint0Decimals === 6 ? 'USDC' : 'token0';
  const sym1 = pool?.mint1Decimals === 9 ? 'WSOL' : pool?.mint1Decimals === 6 ? 'USDC' : 'token1';

  const fromSym = inputIsToken0 ? sym0 : sym1;
  const toSym   = inputIsToken0 ? sym1 : sym0;
  const inMint  = inputIsToken0 ? pool?.token0Mint : pool?.token1Mint;
  const outMint = inputIsToken0 ? pool?.token1Mint : pool?.token0Mint;
  const inDecimals  = inputIsToken0 ? pool?.mint0Decimals : pool?.mint1Decimals;
  const outDecimals = inputIsToken0 ? pool?.mint1Decimals : pool?.mint0Decimals;

  const inBalance  = inMint  ? (ataBalancesByMint[inMint]  ?? 0) : 0;
  const outBalance = outMint ? (ataBalancesByMint[outMint] ?? 0) : 0;

  const amt = parseFloat(amount) || 0;

  // Effective reserves — Raydium CPMM excludes accumulated protocol/fund fees.
  const inputEff  = inputIsToken0 ? poolState?.token0EffectiveReserve : poolState?.token1EffectiveReserve;
  const outputEff = inputIsToken0 ? poolState?.token1EffectiveReserve : poolState?.token0EffectiveReserve;

  // x*y=k constant-product quote with Raydium's ceil-rounded fee deduction.
  const quote = useMemo(() => {
    if (
      !pool ||
      inputEff == null ||
      outputEff == null ||
      poolState?.tradeFeeRatePpm == null ||
      amt <= 0 ||
      inDecimals == null ||
      outDecimals == null
    ) return null;
    const amountIn = BigInt(Math.floor(amt * 10 ** inDecimals));
    if (amountIn <= 0n || inputEff <= 0n || outputEff <= 0n) return null;
    const fee = poolState.tradeFeeRatePpm;
    const tradeFee = (amountIn * fee + 999_999n) / 1_000_000n;
    const amountInAfterFee = amountIn - tradeFee;
    const num = amountInAfterFee * outputEff;
    const den = inputEff + amountInAfterFee;
    const out = num / den;
    return { amountIn, amountOut: out, human: Number(out) / 10 ** outDecimals };
  }, [pool, poolState, amt, inputEff, outputEff, inDecimals, outDecimals]);

  const noLiquidity =
    inputEff != null && outputEff != null && (inputEff <= 0n || outputEff <= 0n);
  const swapDisabled = pool && (pool.status ?? 0) & 1;
  const insufficient = amt > 0 && amt > inBalance;

  const minOutRaw = quote ? (quote.amountOut * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n : 0n;
  const minOut    = quote ? Number(minOutRaw) / 10 ** (outDecimals ?? 6) : 0;
  const rate      = amt > 0 && quote && quote.human > 0 ? quote.human / amt : 0;

  // Pool liquidity (fixed token0/token1 order — independent of swap direction).
  // CPMM effective reserves exclude accrued protocol/fund fees; fall back to raw.
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

  // USD value anchors to the USDC leg (reliably $1).
  // inputIsToken0: paying WSOL → receiving USDC → anchor to output (quote.human)
  // inputIsToken0=false: paying USDC → receiving WSOL → anchor to input (amt)
  const usdValue = inputIsToken0
    ? (quote?.human ?? 0)
    : amt;

  const FEE_PPM   = poolState?.tradeFeeRatePpm != null ? Number(poolState.tradeFeeRatePpm) : 2500;
  const FEE_BPS   = FEE_PPM / 100;
  const liveFee   = usdValue * (FEE_PPM / 1_000_000);
  const liveGas   = 0.008;
  const liveTotal = liveFee + liveGas;

  // Signature plan: Raydium CPMM handles vault ATAs inside the ix.
  // Pass outAtaExists: undefined → optimistic (no setup step unless probe says missing).
  const rawSteps = signaturePlan('swap', { outAtaExists: undefined });
  const steps = rawSteps.map((st) =>
    st.id === 'swap'
      ? { ...st, label: 'Swap on Raydium', detail: 'CPI → Raydium CPMM swap' }
      : st,
  );
  const count = steps.length;

  const phase = swapState?.phase ?? 'idle';
  const isWorking = phase === 'signing' || phase === 'confirming';

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

  let ctaLabel   = 'Swap on Raydium';
  let ctaCaption = '1 signature · settles atomically on Solana';
  let ctaDisabled = false;
  let ctaOnClick;

  if (!wallet?.connected) {
    ctaLabel   = 'Connect wallet';
    ctaCaption = 'one wallet — no bridge, no Phantom';
    ctaOnClick = onConnect;
  } else if (!pool || poolState == null) {
    ctaLabel   = 'Loading pool…';
    ctaDisabled = true;
  } else if (noLiquidity) {
    ctaLabel   = 'No liquidity in pool';
    ctaDisabled = true;
  } else if (swapDisabled) {
    ctaLabel   = 'Swaps disabled on this pool';
    ctaDisabled = true;
  } else {
    ctaDisabled = submitDisabled;
    if (isWorking) {
      ctaLabel = phase === 'confirming' ? 'Settling on Solana…' : 'Confirm in MetaMask…';
    } else if (insufficient) {
      ctaLabel = `Insufficient ${fromSym}`;
    } else {
      ctaLabel = 'Swap on Raydium';
    }
    ctaOnClick = () => {
      if (!quote) return;
      onSwap?.({ inputIsToken0, amountIn: quote.amountIn, minimumAmountOut: minOutRaw });
    };
  }

  // Status line in the see column.
  let statusNode = <>Preview · this is exactly what your wallet will sign</>;
  if (phase === 'signing')   statusNode = <>Confirm in MetaMask…</>;
  else if (phase === 'confirming') statusNode = <>Settling on Solana…</>;
  else if (phase === 'success')
    statusNode = (
      <>
        <span className={s.ok}>✓ Settled on Raydium</span>
        {swapState?.hash ? <> · <TxHash hash={swapState.hash} /></> : null}
      </>
    );
  else if (phase === 'failed') statusNode = <span className={s.bad}>Reverted · try again</span>;

  // Reset amount when direction flips (same UX as old screen).
  useEffect(() => { setAmount(''); }, [inputIsToken0]);

  // Icon colour classes — WSOL → sol, USDC → usdc.
  const icFrom = fromSym === 'WSOL' ? s.sol : s.usdc;
  const icTo   = toSym   === 'WSOL' ? s.sol : s.usdc;

  return (
    <main className={s.work}>
      <div className={s.strip}>
        <div className={s.lead}>
          <span className={s.eyebrow}>Raydium CPMM · constant product</span>
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
            if (ctaOnClick) ctaOnClick();
          }}
        >
          <div className={s.colhd}>
            <span className={s.sd} /> You do this
          </div>

          <div className={s.leg}>
            <div className={s.r1}>
              <label>You pay</label>
              <span className={s.bal}>
                balance <b>{fmtNum(inBalance)}</b> {fromSym}
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
                <span className={`${s.ic} ${icFrom}`}>{fromSym.charAt(1).toLowerCase()}</span>
                <span className={s.sym}>{fromSym}</span>
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
              aria-label="Flip"
              onClick={() => setInputIsToken0((v) => !v)}
            >
              ⇅
            </button>
          </div>

          <div className={s.leg}>
            <div className={s.r1}>
              <label>You receive</label>
              <span className={s.bal}>
                balance <b>{fmtNum(outBalance)}</b> {toSym}
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
                <span className={`${s.ic} ${icTo}`}>{toSym.charAt(1).toLowerCase()}</span>
                <span className={s.sym}>{toSym}</span>
              </div>
            </div>
          </div>

          <div className={s.slip}>
            <span className={s.lbl}>Slippage</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)' }}>
              {SLIPPAGE_BPS / 100}% (fixed)
            </span>
          </div>

          <div className={s['cta-wrap']}>
            <button className={s.cta} type="submit" disabled={ctaDisabled}>
              <span>{ctaLabel}</span>
              <span className={s.sig}>{ctaCaption}</span>
            </button>
          </div>
        </form>

        {/* ── SEE ── */}
        <section className={`${s.col} ${s.see}`}>
          <div className={s.colhd}>
            <span className={s.sd} /> What will happen
            <span className={s.pool}>Raydium CPMM · cp-swap</span>
          </div>
          <div className={s.body}>
            <Ledger
              steps={steps}
              count={count}
              loading={false}
              sub={
                <>
                  One wallet — <b>no bridge, no Phantom, no second account</b>. Routes through
                  Raydium&apos;s constant-product pool on Solana.
                </>
              }
            />
            <div className={s.outcome}>
              <div className={`${s.ln} ${s.get}`}>
                <span className={s.k}>You receive at least</span>
                <span className={s.v}>
                  {fmtNum(minOut, 6)} {toSym}
                </span>
              </div>
              <div className={s.ln}>
                <span className={s.k}>Rate</span>
                <span className={s.v}>
                  {rate > 0
                    ? `1 ${fromSym} = ${fmtNum(rate, 6)} ${toSym}`
                    : '—'}
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
                  Pool fee{' '}
                  <small>
                    {poolState?.tradeFeeRatePpm != null
                      ? `${FEE_BPS} bps`
                      : '—'}
                  </small>
                </span>
                <span className={s.v}>{fmtUSD(liveFee)}</span>
              </div>
              <div className={s.ln}>
                <span className={s.k}>EVM gas · Rome</span>
                <span className={s.v}>{fmtUSD(liveGas, { decimals: 3 })}</span>
              </div>
              <div className={s.ln}>
                <span className={s.k}>Total cost</span>
                <span className={s.v}>{fmtUSD(liveTotal)}</span>
              </div>
              <div className={s.note}>
                {insufficient ? (
                  <>
                    Amount exceeds your <b>{fromSym}</b> balance — reduce the amount or flip
                    direction.
                  </>
                ) : (
                  <>
                    The trade and your balance change land <b>together, or neither</b> — one atomic
                    Rome transaction at the pool&apos;s live price.
                  </>
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
