'use client';
// SwapRaydiumAmm screen — act|see redesign. Swap WSOL ↔ USDC through
// Raydium AMM v4 (legacy hand-rolled AMM) on Solana, from one EVM wallet.
// Left: the trade form. Right: the live signature ledger.
//
// Quote uses AMM v4 constant-product (x*y=k) with the pool's own
// tradeFeeNumerator / tradeFeeDenominator from AmmInfo.fees — the same
// math the on-chain program runs, so the shown floor is honest.
// minimumAmountOut enforces a 2% slippage guard (200 bps).
//
// Working parts lifted from the tested hooks; only presentation is new.

import React, { useEffect, useMemo, useState } from 'react';
import { fmtUSD, fmtNum } from '../primitives';
import { Ledger } from '../design/Ledger';
import { TxHash } from '../design/Inline';
import { signaturePlan } from '../../lib/signature-plan';
import { compactNum } from '../../lib/stats-format';
import s from '../design/actsee.module.css';

const SLIPPAGE_BPS = 200; // 2.00% — AMM v4 + Serum CPI can be choppier.

export function SwapRaydiumAmm({
  wallet,
  onConnect,
  pool,
  poolState,
  ataBalancesByMint = {},
  onSwap,
  swapState,
}) {
  // coin=USDC, pc=WSOL on the seeded devnet pool.
  // inputIsCoin true  → USDC → WSOL
  // inputIsCoin false → WSOL → USDC
  const [inputIsCoin, setInputIsCoin] = useState(true);
  const [amount, setAmount] = useState('');

  // Reset amount when direction flips (mirrors original).
  useEffect(() => {
    setAmount('');
  }, [inputIsCoin]);

  // Derive display symbols from the pool's decimal fields.
  const symCoin =
    pool?.coinDecimals === 9
      ? 'WSOL'
      : pool?.coinDecimals === 6
        ? 'USDC'
        : 'coin';
  const symPc =
    pool?.pcDecimals === 9
      ? 'WSOL'
      : pool?.pcDecimals === 6
        ? 'USDC'
        : 'pc';

  const inSym = inputIsCoin ? symCoin : symPc;
  const outSym = inputIsCoin ? symPc : symCoin;
  const inMint = inputIsCoin ? pool?.coinMint : pool?.pcMint;
  const outMint = inputIsCoin ? pool?.pcMint : pool?.coinMint;
  const inDecimals = inputIsCoin ? pool?.coinDecimals : pool?.pcDecimals;
  const outDecimals = inputIsCoin ? pool?.pcDecimals : pool?.coinDecimals;

  const inBalance = inMint ? (ataBalancesByMint[inMint] ?? 0) : 0;
  const outBalance = outMint ? (ataBalancesByMint[outMint] ?? 0) : 0;

  const amt = parseFloat(amount) || 0;

  // Effective reserves — AMM v4 nets out need_take_pnl_* before its CP math.
  const inputEff = inputIsCoin
    ? poolState?.coinEffectiveReserve
    : poolState?.pcEffectiveReserve;
  const outputEff = inputIsCoin
    ? poolState?.pcEffectiveReserve
    : poolState?.coinEffectiveReserve;

  // Constant-product quote with the pool's own fee params.
  const quote = useMemo(() => {
    if (
      !pool ||
      inputEff == null ||
      outputEff == null ||
      poolState?.pool == null ||
      amt <= 0 ||
      inDecimals == null ||
      outDecimals == null
    ) {
      return null;
    }
    const amountIn = BigInt(Math.floor(amt * 10 ** inDecimals));
    if (amountIn <= 0n || inputEff <= 0n || outputEff <= 0n) return null;
    const num = poolState.pool.tradeFeeNumerator;
    const den = poolState.pool.tradeFeeDenominator;
    if (den <= 0n) return null;
    // Floor on the trade-fee deduction matches Raydium's u64 arithmetic.
    const amountInAfterFee = (amountIn * (den - num)) / den;
    if (amountInAfterFee <= 0n) return null;
    const numOut = amountInAfterFee * outputEff;
    const denOut = inputEff + amountInAfterFee;
    const amountOut = numOut / denOut;
    return { amountIn, amountOut, human: Number(amountOut) / 10 ** outDecimals };
  }, [pool, poolState, amt, inputEff, outputEff, inDecimals, outDecimals]);

  const minOutRaw = quote ? (quote.amountOut * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n : 0n;
  const minOutHuman = outDecimals != null ? Number(minOutRaw) / 10 ** outDecimals : 0;
  const rate = amt > 0 && quote?.human ? quote.human / amt : 0;

  // USD value anchors to the USDC leg (reliably $1): whichever leg is USDC.
  // coin=USDC, pc=WSOL. inputIsCoin → we pay USDC (in), receive WSOL (out).
  // USD value = the USDC amount (in if inputIsCoin, out otherwise).
  const usdValue = inputIsCoin ? amt : (quote?.human ?? 0);

  const noLiquidity =
    inputEff != null && outputEff != null && (inputEff <= 0n || outputEff <= 0n);

  const outputEffHuman =
    outputEff != null && outDecimals != null
      ? Number(outputEff) / 10 ** outDecimals
      : null;
  const thinPool = outputEffHuman != null && outputEffHuman < 1;

  // Pool liquidity (fixed pool order, coin=USDC / pc=WSOL — independent of swap
  // direction). Effective reserves net out need_take_pnl_*; fall back to raw.
  const coinReserveRaw = poolState?.coinEffectiveReserve ?? poolState?.coinReserve;
  const pcReserveRaw = poolState?.pcEffectiveReserve ?? poolState?.pcReserve;
  const coinLiqHuman =
    coinReserveRaw != null && pool?.coinDecimals != null
      ? Number(coinReserveRaw) / 10 ** pool.coinDecimals
      : null;
  const pcLiqHuman =
    pcReserveRaw != null && pool?.pcDecimals != null
      ? Number(pcReserveRaw) / 10 ** pool.pcDecimals
      : null;

  const poolStatusNum =
    poolState?.pool?.status != null ? Number(poolState.pool.status) : null;
  const swapDisabled =
    poolStatusNum != null &&
    poolStatusNum !== 1 &&
    poolStatusNum !== 6 &&
    poolStatusNum !== 7;

  const phase = swapState?.phase ?? 'idle';
  const busy = phase === 'signing' || phase === 'confirming';
  const insufficient = amt > 0 && amt > inBalance;

  // Fee display.
  const feeBps = useMemo(() => {
    const p = poolState?.pool;
    if (!p || p.tradeFeeDenominator <= 0n) return null;
    return Number((p.tradeFeeNumerator * 10_000n) / p.tradeFeeDenominator);
  }, [poolState?.pool]);

  const liveFee = feeBps != null ? usdValue * (feeBps / 10_000) : 0;
  const liveGas = 0.008;
  const liveTotal = liveFee + liveGas;

  // Ledger — static plan (outAtaExists: undefined = optimistic, no setup step
  // flashes while probes are in flight) with the swap step relabeled for AMM v4.
  const steps = signaturePlan('swap', { outAtaExists: undefined }).map((st) =>
    st.id === 'swap'
      ? { ...st, label: 'Swap on Raydium AMM', detail: 'CPI → Raydium AMM v4 swap' }
      : st,
  );
  const planCount = steps.length;

  // CTA state.
  let ctaLabel = `Swap ${inSym} → ${outSym}`;
  let ctaCaption = '1 signature · settles atomically on Solana';
  let ctaDisabled = false;
  let ctaOnClick;

  if (!wallet?.connected) {
    ctaLabel = 'Connect wallet';
    ctaCaption = 'one wallet — no bridge, no Phantom';
    ctaOnClick = onConnect;
  } else if (!pool || poolState == null) {
    ctaLabel = 'Loading pool…';
    ctaDisabled = true;
  } else if (noLiquidity) {
    ctaLabel = 'No liquidity in pool';
    ctaDisabled = true;
  } else if (swapDisabled) {
    ctaLabel = `Pool status ${poolStatusNum} — swap disabled`;
    ctaDisabled = true;
  } else if (thinPool) {
    ctaLabel = 'Thin pool — small amounts only';
    ctaCaption = `< 1 ${outSym} effective reserve`;
    ctaDisabled =
      busy || amt <= 0 || insufficient || !quote || quote.amountOut <= 0n;
    ctaOnClick = () => {
      if (!quote) return;
      onSwap?.({ inputIsCoin, amountIn: quote.amountIn, minimumAmountOut: minOutRaw });
    };
  } else {
    ctaDisabled =
      busy || amt <= 0 || insufficient || !quote || quote.amountOut <= 0n;
    ctaLabel = busy
      ? 'Swapping…'
      : insufficient
        ? `Insufficient ${inSym}`
        : `Swap ${inSym} → ${outSym}`;
    ctaOnClick = () => {
      if (!quote) return;
      onSwap?.({ inputIsCoin, amountIn: quote.amountIn, minimumAmountOut: minOutRaw });
    };
  }

  // Status node.
  let statusNode = <>Preview · this is exactly what your wallet will sign</>;
  if (phase === 'signing') {
    statusNode = <>Confirm in MetaMask…</>;
  } else if (phase === 'confirming') {
    statusNode = <>Settling on Solana…</>;
  } else if (phase === 'success') {
    statusNode = (
      <>
        <span className={s.ok}>✓ Settled on Raydium AMM</span>
        {swapState?.hash ? (
          <>
            {' '}
            · <TxHash hash={swapState.hash} />
          </>
        ) : null}
      </>
    );
  } else if (phase === 'failed') {
    statusNode = <span className={s.bad}>Reverted · try again</span>;
  }

  // Token icon classes — coin=USDC (gold), pc=WSOL (green).
  const icIn = inputIsCoin ? s.usdc : s.sol;
  const icOut = inputIsCoin ? s.sol : s.usdc;

  return (
    <main className={s.work}>
      <div className={s.strip}>
        <div className={s.lead}>
          <span className={s.eyebrow}>Raydium AMM v4 · constant product</span>
          <h1>
            Swap on Raydium AMM from your EVM wallet — <em>one wallet, no bridge</em>.
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

          {/* Pay leg */}
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
                <span className={`${s.ic} ${icIn}`}>{inSym.charAt(1).toLowerCase()}</span>
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

          {/* Flip */}
          <div className={s.flipwrap}>
            <button
              type="button"
              className={s.flip}
              aria-label="Flip direction"
              onClick={() => setInputIsCoin((v) => !v)}
            >
              ⇅
            </button>
          </div>

          {/* Receive leg */}
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
                <span className={`${s.ic} ${icOut}`}>{outSym.charAt(1).toLowerCase()}</span>
                <span className={s.sym}>{outSym}</span>
              </div>
            </div>
          </div>

          {/* CTA */}
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
            <span className={s.pool}>
              Raydium AMM v4 · {pool?.label ?? 'USDC/WSOL'}
            </span>
          </div>
          <div className={s.body}>
            <Ledger
              steps={steps}
              count={planCount}
              loading={false}
              sub={
                <>
                  One wallet — <b>no bridge, no Phantom, no second account</b>. Routes through
                  Raydium&apos;s legacy AMM (constant-product + Serum CPI) on Solana.
                </>
              }
            />
            <div className={s.outcome}>
              <div className={`${s.ln} ${s.get}`}>
                <span className={s.k}>You receive at least</span>
                <span className={s.v}>
                  {fmtNum(minOutHuman, 6)} {outSym}
                </span>
              </div>
              <div className={s.ln}>
                <span className={s.k}>Rate</span>
                <span className={s.v}>
                  {rate > 0
                    ? `1 ${inSym} = ${fmtNum(rate, 6)} ${outSym}`
                    : '—'}
                </span>
              </div>
              <div className={s.ln}>
                <span className={s.k}>Pool liquidity</span>
                <span className={s.v}>
                  {coinLiqHuman != null ? `${compactNum(coinLiqHuman)} ${symCoin}` : '—'} · {pcLiqHuman != null ? `${compactNum(pcLiqHuman)} ${symPc}` : '—'}
                </span>
              </div>
              <div className={s.ln}>
                <span className={s.k}>
                  Pool fee{feeBps != null && <small> {feeBps} bps</small>}
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
                {thinPool ? (
                  <>
                    Devnet pool has only{' '}
                    <b>
                      {fmtNum(outputEffHuman ?? 0, 4)} {outSym}
                    </b>{' '}
                    of effective swappable reserve — keep amounts small to avoid a
                    slippage revert.
                  </>
                ) : (
                  <>
                    The trade and your balance change land <b>together, or neither</b> — one
                    atomic Rome transaction. Raydium CPIs into Serum/OpenBook for orderbook
                    integration.
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
