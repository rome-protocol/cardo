'use client';
// SwapDlmm screen — act|see redesign. Swap wUSDC ↔ wSOL through a Meteora
// DLMM bin-step pool on Solana, from one EVM wallet. Left: the trade form.
// Right: the live signature ledger. Quote math uses the bin-step price formula
// `(1 + bin_step/10000)^bin_id` (single-bin approximation); a slippage guard
// absorbs multi-bin crossings. Preserves all direction-safety and thin-pool
// logic from the old screen — only the presentation changes.

import React, { useEffect, useMemo, useState } from 'react';
import { fmtUSD, fmtNum } from '../primitives';
import { Ledger } from '../design/Ledger';
import { TxHash } from '../design/Inline';
import { signaturePlan } from '../../lib/signature-plan';
import { compactNum } from '../../lib/stats-format';
import { quoteDlmmSwapSingleBin } from '@/lib/dlmm-pools';
import s from '../design/actsee.module.css';

const SLIPPAGE_BPS = 200; // 2.00% default; devnet pools are thin

export function SwapDlmm({
  wallet,
  onConnect,
  pool,
  poolState,
  ataBalancesByMint = {},
  onSwap,
  swapState,
}) {
  // direction: true = swapXForY = USDC→WSOL (tokenX = USDC, tokenY = WSOL)
  const [swapXForY, setSwapXForY] = useState(false); // default Y→X (WSOL→USDC)
  const [amount, setAmount] = useState('');

  // Derive display symbols from pool decimals: 6→USDC, 9→WSOL
  const symX =
    pool?.mintXDecimals === 9 ? 'wSOL' : pool?.mintXDecimals === 6 ? 'wUSDC' : 'wTokenX';
  const symY =
    pool?.mintYDecimals === 9 ? 'wSOL' : pool?.mintYDecimals === 6 ? 'wUSDC' : 'wTokenY';

  const fromSym = swapXForY ? symX : symY;
  const toSym = swapXForY ? symY : symX;
  const inMint = swapXForY ? pool?.tokenXMint : pool?.tokenYMint;
  const inDecimals = swapXForY ? pool?.mintXDecimals : pool?.mintYDecimals;
  const outDecimals = swapXForY ? pool?.mintYDecimals : pool?.mintXDecimals;

  const fromBalance = inMint ? (ataBalancesByMint[inMint] ?? 0) : 0;

  const amt = parseFloat(amount) || 0;
  const phase = swapState?.phase ?? 'idle';
  const isWorking = phase === 'signing' || phase === 'confirming';

  // Live indicative quote — DLMM single-bin price math (same as old screen)
  const quote = useMemo(() => {
    if (
      !pool ||
      !poolState?.pool ||
      poolState.baseFeeRatePpb == null ||
      amt <= 0 ||
      inDecimals == null ||
      outDecimals == null
    ) {
      return null;
    }
    const live = poolState.pool;
    const amountIn = BigInt(Math.floor(amt * 10 ** inDecimals));
    if (amountIn <= 0n) return null;

    const out = quoteDlmmSwapSingleBin({
      activeId: live.activeId,
      binStep: live.binStep,
      decimalsX: pool.mintXDecimals,
      decimalsY: pool.mintYDecimals,
      amountIn,
      feeRatePpb: poolState.baseFeeRatePpb,
      xForY: swapXForY,
    });
    return { amountIn, amountOut: out, human: Number(out) / 10 ** outDecimals };
  }, [pool, poolState, amt, swapXForY, inDecimals, outDecimals]);

  // Minimum out after slippage
  const minOut =
    quote != null ? Number((quote.amountOut * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n) / 10 ** (outDecimals ?? 6) : 0;

  // Pool status and direction safety checks (preserved from old screen)
  const statusByte = poolState?.pool?.status ?? 0;
  const swapDisabled = statusByte !== 0;
  const upperOk = pool?.neighborUpperExists ?? false;
  const lowerOk = pool?.neighborLowerExists ?? false;
  const directionUnsafe = swapXForY && !upperOk ? 'upper' : !swapXForY && !lowerOk ? 'lower' : null;

  // Thin-pool guard
  const outputEff = swapXForY ? poolState?.reserveYEffective : poolState?.reserveXEffective;
  const outputEffHuman =
    outputEff != null && outDecimals != null ? Number(outputEff) / 10 ** outDecimals : null;
  const thinPool = outputEffHuman != null && outputEffHuman < 0.5;

  // Pool liquidity (fixed tokenX/tokenY order — independent of swap direction).
  // Effective bin reserves when available; fall back to raw.
  const reserveXRawDisplay = poolState?.reserveXEffective ?? poolState?.reserveXRaw;
  const reserveYRawDisplay = poolState?.reserveYEffective ?? poolState?.reserveYRaw;
  const liqXHuman =
    reserveXRawDisplay != null && pool?.mintXDecimals != null
      ? Number(reserveXRawDisplay) / 10 ** pool.mintXDecimals
      : null;
  const liqYHuman =
    reserveYRawDisplay != null && pool?.mintYDecimals != null
      ? Number(reserveYRawDisplay) / 10 ** pool.mintYDecimals
      : null;

  // USD anchor: USDC leg is always $1 so anchor to it
  // swapXForY: spending USDC (symX=wUSDC when mintXDecimals=6), receiving WSOL
  //   usdValue = spent USDC amount = amt (if symX=wUSDC) or quote.human (if symY=wUSDC)
  // Detect which side is USDC by decimals=6
  const usdcIsX = pool?.mintXDecimals === 6;
  const usdValue =
    usdcIsX
      ? swapXForY
        ? amt           // spending wUSDC (X)
        : quote?.human ?? 0  // receiving wUSDC (X)
      : swapXForY
        ? quote?.human ?? 0  // receiving wUSDC (Y)
        : amt;               // spending wUSDC (Y)

  const rate = amt > 0 && (quote?.human ?? 0) > 0 ? (quote?.human ?? 0) / amt : 0;

  const baseFeePct =
    poolState?.baseFeeRatePpb != null
      ? Number(poolState.baseFeeRatePpb) / 1e7 // ppb → %: ppb/1e9*100 = ppb/1e7
      : null;
  const liveFee = usdValue * ((baseFeePct ?? 0) / 100);
  const liveGas = 0.008;
  const liveTotal = liveFee + liveGas;

  // Signature plan — swap flow, optimistic (outAtaExists: undefined)
  const steps = signaturePlan('swap', { outAtaExists: undefined }).map((st) =>
    st.id === 'swap'
      ? { ...st, label: 'Swap on Meteora DLMM', detail: 'CPI → DLMM bin swap' }
      : st,
  );
  const loading = poolState?.loading ?? false;

  // CTA logic
  const insufficient = amt > 0 && amt > fromBalance;
  const submitDisabled =
    !wallet?.connected ||
    !pool ||
    swapDisabled ||
    amt <= 0 ||
    insufficient ||
    isWorking ||
    !quote ||
    quote.amountOut <= 0n ||
    !!directionUnsafe;

  let ctaLabel = `Swap ${fromSym} → ${toSym}`;
  let ctaCaption = '1 signature · settles atomically on Solana';
  let ctaOnClick;
  if (!wallet?.connected) {
    ctaLabel = 'Connect wallet';
    ctaCaption = 'one wallet — no bridge, no Phantom';
    ctaOnClick = onConnect;
  } else if (loading || poolState?.pool == null) {
    ctaLabel = 'Loading pool…';
  } else if (swapDisabled) {
    ctaLabel = 'Pool swaps disabled';
  } else if (directionUnsafe) {
    ctaLabel = 'Direction unsafe — flip side';
  } else if (insufficient) {
    ctaLabel = `Insufficient ${fromSym}`;
  } else if (isWorking) {
    ctaLabel = phase === 'signing' ? 'Awaiting signature…' : 'Confirming on Solana…';
  } else {
    ctaOnClick = () => {
      if (!quote) return;
      const slippageMul = BigInt(10_000 - SLIPPAGE_BPS);
      const minimumAmountOut = (quote.amountOut * slippageMul) / 10_000n;
      onSwap?.({ swapXForY, amountIn: quote.amountIn, minimumAmountOut });
    };
  }

  // Status line
  let statusNode = <>Preview · this is exactly what your wallet will sign</>;
  if (phase === 'signing') statusNode = <>Confirm in MetaMask…</>;
  else if (phase === 'confirming') statusNode = <>Settling on Solana…</>;
  else if (phase === 'success')
    statusNode = (
      <>
        <span className={s.ok}>✓ Settled on DLMM</span>
        {swapState?.hash ? <> · <TxHash hash={swapState.hash} /></> : null}
      </>
    );
  else if (phase === 'failed')
    statusNode = <span className={s.bad}>Reverted · try again</span>;

  // Reset amount when direction flips
  useEffect(() => { setAmount(''); }, [swapXForY]);

  const icFrom = fromSym === 'wUSDC' ? s.usdc : fromSym === 'wSOL' ? s.sol : s.gen;
  const icTo = toSym === 'wUSDC' ? s.usdc : toSym === 'wSOL' ? s.sol : s.gen;
  const icFromChar = fromSym === 'wUSDC' ? 'u' : fromSym === 'wSOL' ? 's' : 'x';
  const icToChar = toSym === 'wUSDC' ? 'u' : toSym === 'wSOL' ? 's' : 'x';

  return (
    <main className={s.work}>
      <div className={s.strip}>
        <div className={s.lead}>
          <span className={s.eyebrow}>Meteora DLMM · bin-step concentrated</span>
          <h1>
            Swap on Meteora DLMM from your EVM wallet — <em>one wallet, no bridge</em>.
          </h1>
        </div>
        <span className={s.routepill}>
          <span className={`${s.dot} ${s.evm}`} /> EVM · Rome <span className={s.ar}>→</span> Meteora{' '}
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

          {/* Warnings — thin pool or unsafe direction */}
          {(thinPool || directionUnsafe) && (
            <div
              style={{
                margin: '10px 20px 0',
                padding: '8px 12px',
                borderRadius: 6,
                fontSize: 11.5,
                lineHeight: 1.5,
                background: directionUnsafe
                  ? 'color-mix(in srgb, var(--accent) 10%, transparent)'
                  : 'rgba(207,82,46,0.08)',
                border: `1px solid ${directionUnsafe ? 'color-mix(in srgb, var(--accent) 35%, transparent)' : 'rgba(207,82,46,0.25)'}`,
                color: 'var(--muted)',
              }}
            >
              {directionUnsafe
                ? `Bin array on the ${directionUnsafe === 'upper' ? `${fromSym} → ${toSym}` : `${fromSym} → ${toSym}`} side is missing — a boundary-crossing swap would revert. Flip direction or use a tiny amount.`
                : `Thin pool: only ${fmtNum(outputEffHuman ?? 0, 6)} ${toSym} effective reserve. Even small swaps may revert.`}
            </div>
          )}

          <div className={s.leg}>
            <div className={s.r1}>
              <label>You pay</label>
              <span className={s.bal}>
                balance <b>{fmtNum(fromBalance, 4)}</b> {fromSym}
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
                <span className={`${s.ic} ${icFrom}`}>{icFromChar}</span>
                <span className={s.sym}>{fromSym}</span>
              </div>
            </div>
            <div className={s.pct}>
              {[25, 50, 100].map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() =>
                    setAmount(((fromBalance * p) / 100).toFixed(6).replace(/\.?0+$/, ''))
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
              onClick={() => setSwapXForY((v) => !v)}
            >
              ⇅
            </button>
          </div>

          <div className={s.leg}>
            <div className={s.r1}>
              <label>You receive</label>
            </div>
            <div className={s.r2}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className={`${s.amt} ${s.out}`}>
                  {quote && quote.human > 0 ? fmtNum(quote.human, 6) : '0.00'}
                </div>
                <div className={s.usd}>≈ {fmtUSD(usdValue)}</div>
              </div>
              <div className={s.tokchip}>
                <span className={`${s.ic} ${icTo}`}>{icToChar}</span>
                <span className={s.sym}>{toSym}</span>
              </div>
            </div>
          </div>

          <div className={s.slip}>
            <span className={s.lbl}>Slippage</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)' }}>
              {SLIPPAGE_BPS / 100}% (devnet thin-pool guard)
            </span>
          </div>

          <div className={s['cta-wrap']}>
            <button className={s.cta} type="submit" disabled={submitDisabled || !ctaOnClick}>
              <span>{ctaLabel}</span>
              <span className={s.sig}>{ctaCaption}</span>
            </button>
          </div>
        </form>

        {/* ── SEE ── */}
        <section className={`${s.col} ${s.see}`}>
          <div className={s.colhd}>
            <span className={s.sd} /> What will happen
            <span className={s.pool}>Meteora DLMM · bin step {pool?.binStep ?? '—'}</span>
          </div>
          <div className={s.body}>
            <Ledger
              steps={steps}
              count={steps.length}
              loading={loading}
              sub={
                <>
                  One wallet — <b>no bridge, no Phantom, no second account</b>. Routes through
                  Meteora&apos;s bin-step pool on Solana.
                </>
              }
            />
            <div className={s.outcome}>
              <div className={`${s.ln} ${s.get}`}>
                <span className={s.k}>You receive at least</span>
                <span className={s.v}>
                  {minOut > 0 ? fmtNum(minOut, 6) : '—'} {toSym}
                </span>
              </div>
              {rate > 0 && (
                <div className={s.ln}>
                  <span className={s.k}>Rate (indicative)</span>
                  <span className={s.v}>
                    1 {fromSym} = {fmtNum(rate, 6)} {toSym}
                  </span>
                </div>
              )}
              <div className={s.ln}>
                <span className={s.k}>Pool liquidity</span>
                <span className={s.v}>
                  {liqXHuman != null ? `${compactNum(liqXHuman)} ${symX}` : '—'} · {liqYHuman != null ? `${compactNum(liqYHuman)} ${symY}` : '—'}
                </span>
              </div>
              <div className={s.ln}>
                <span className={s.k}>
                  Pool fee (base){' '}
                  <small>{baseFeePct != null ? `${fmtNum(baseFeePct, 2)}%` : '—'}</small>
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
                Single-bin quote · {SLIPPAGE_BPS / 100}% slippage guard absorbs multi-bin
                crossings.{' '}
                {pool?.binStep != null && (
                  <>Bin step {pool.binStep} bp · active bin {poolState?.pool?.activeId ?? '—'}.</>
                )}{' '}
                Trade and balance land <b>together, or neither</b>.
              </div>
            </div>
          </div>
          <div className={s.status}>{statusNode}</div>
        </section>
      </div>
    </main>
  );
}
