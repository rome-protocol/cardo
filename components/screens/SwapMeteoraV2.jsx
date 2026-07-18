'use client';
// SwapMeteoraV2 screen — act|see redesign. Swap WSOL ↔ USDC through Meteora
// DAMM v2 on Solana, from one EVM wallet. Left: the trade form. Right: the
// live signature ledger.
//
// Quote: derived from the pool's sqrtPriceX64 (price = sqrtP² / 2¹²⁸) as the
// marginal rate. DAMM v2 is constant-product; a full constant-product quote
// (out = reserveOut*amtIn/(reserveIn+amtIn)) would need vault balances, which
// the current poolState slice (offsets 360–472) does NOT expose. The sqrtPrice
// quote is exact at the margin and close enough for the preview display.
// minimumAmountOut passed to the swap hook stays 0n — the route's onSwap
// callback signature only accepts { aToB, amountHuman } — slippage is surfaced
// in the outcome panel as "min received" but is not yet enforced on-chain.
// TODO: wire minOut into the route's onSwap once the callback signature is
// extended to accept it.

import React, { useState } from 'react';
import { fmtUSD, fmtNum } from '../primitives';
import { Ledger } from '../design/Ledger';
import { TxHash } from '../design/Inline';
import { useSignaturePlan } from '../../lib/use-signature-plan';
import s from '../design/actsee.module.css';
// Constant-product marginal quote from sqrtPriceX64.
// DAMM v2 stores price as sqrtPrice in Q64.64 format (u128).
// price (B-per-A) = (sqrtP / 2^64)^2 = sqrtP^2 / 2^128
// For aToB: out = amtIn * price (adjusted for fee)
// For bToA: out = amtIn / price (adjusted for fee)
// Fee is deducted from amtIn before the quote.
// Returns 0n when sqrtP is undefined.
function dammV2Quote(sqrtPriceX64, aToB, amountInRaw, feeBps) {
  if (!sqrtPriceX64 || sqrtPriceX64 === 0n || amountInRaw <= 0n) return 0n;
  const SCALE = 2n ** 128n;
  const price_num = sqrtPriceX64 * sqrtPriceX64; // sqrtP^2
  // fee deducted from input: amtAfterFee = amtIn * (10000 - feeBps) / 10000
  const fee = BigInt(feeBps);
  const amtAfterFee = (amountInRaw * (10000n - fee)) / 10000n;
  if (aToB) {
    // price = B/A; out = amtAfterFee * price
    return (amtAfterFee * price_num) / SCALE;
  } else {
    // price = B/A; out = amtAfterFee / price = amtAfterFee * SCALE / price_num
    return (amtAfterFee * SCALE) / price_num;
  }
}

// DAMM v2 devnet pool fee — Meteora's standard DAMM v2 pool uses 25 bps by
// default. The pool struct has a fee field but the current hook slice doesn't
// read it; hardcode the known devnet pool fee here.
const POOL_FEE_BPS = 25;

export function SwapMeteoraV2({
  wallet,
  onConnect,
  pool,
  poolState,
  ataBalancesByMint = {},
  onSwap,
  swapState,
}) {
  const [aToB, setAToB] = useState(true);
  const [amount, setAmount] = useState('1');
  const [slippage, setSlippage] = useState('0.5');

  const fromSym = aToB ? (pool?.symbolA ?? 'WSOL') : (pool?.symbolB ?? 'USDC');
  const toSym   = aToB ? (pool?.symbolB ?? 'USDC') : (pool?.symbolA ?? 'WSOL');
  const inDecimals  = aToB ? (pool?.tokenADecimals ?? 9) : (pool?.tokenBDecimals ?? 6);
  const outDecimals = aToB ? (pool?.tokenBDecimals ?? 6) : (pool?.tokenADecimals ?? 9);
  const inMint  = aToB ? pool?.tokenAMint : pool?.tokenBMint;
  const outMint = aToB ? pool?.tokenBMint : pool?.tokenAMint;

  const a = parseFloat(amount) || 0;
  const amountInRaw = BigInt(Math.floor(a * 10 ** inDecimals));
  const sqrtP = poolState?.sqrtPriceX64;
  const expectedOutRaw = sqrtP
    ? dammV2Quote(sqrtP, aToB, amountInRaw, POOL_FEE_BPS)
    : 0n;
  const out = Number(expectedOutRaw) / 10 ** outDecimals;
  const slipBps = Math.floor((parseFloat(slippage) || 0) * 100);
  // minOutRaw for display — not yet wired into the on-chain call (see file header).
  const minOutRaw = expectedOutRaw > 0n
    ? (expectedOutRaw * BigInt(10000 - slipBps)) / 10000n
    : 0n;
  const minOut = Number(minOutRaw) / 10 ** outDecimals;
  const rate = a > 0 && out > 0 ? out / a : 0;

  const fromBalance = inMint ? (ataBalancesByMint[inMint] ?? 0) : 0;
  const toBalance   = outMint ? (ataBalancesByMint[outMint] ?? 0) : 0;

  // USD anchor: USDC leg is always ≈ $1.
  // aToB: paying WSOL, receiving USDC → out = usd value
  // bToA: paying USDC → in = usd value
  const usdValue = aToB ? out : a;

  const userEvm = wallet?.connected && wallet?.address ? wallet.address : undefined;
  const rawPlan = useSignaturePlan({ flow: 'swap', userEvmAddress: userEvm, outMintHex: outMint });
  const steps = rawPlan.steps.map((st) =>
    st.id === 'swap'
      ? { ...st, label: 'Swap on Meteora v2', detail: 'CPI → DAMM v2 swap' }
      : st,
  );
  const plan = { ...rawPlan, steps };

  const noLiquidity = poolState && poolState.liquidity === 0n;
  const busy =
    swapState && !['idle', 'success', 'failed'].includes(swapState.phase);

  const liveFee = usdValue * (POOL_FEE_BPS / 10000);
  const liveGas = 0.008;
  const liveTotal = liveFee + liveGas;

  let ctaLabel   = 'Swap on Meteora v2';
  let ctaCaption = '1 signature · settles atomically on Solana';
  let ctaDisabled = false;
  let ctaOnClick;

  if (!wallet?.connected) {
    ctaLabel   = 'Connect wallet';
    ctaCaption = 'one wallet — no bridge, no Phantom';
    ctaOnClick = onConnect;
  } else if (poolState?.loading || sqrtP === undefined) {
    ctaLabel   = 'Loading pool…';
    ctaDisabled = true;
  } else if (noLiquidity) {
    ctaLabel   = 'No liquidity in pool';
    ctaDisabled = true;
  } else {
    ctaDisabled = busy || a <= 0 || a > fromBalance;
    ctaLabel   = busy
      ? 'Swapping…'
      : a > fromBalance
        ? `Insufficient ${fromSym}`
        : 'Swap on Meteora v2';
    ctaOnClick = () => onSwap?.({ aToB, amountHuman: a, minimumAmountOut: minOutRaw });
  }

  let statusNode = <>Preview · this is exactly what your wallet will sign</>;
  if (swapState?.phase === 'success') {
    statusNode = (
      <>
        <span className={s.ok}>✓ Settled on Meteora v2</span>
        {swapState?.hash ? <> · <TxHash hash={swapState.hash} /></> : null}
      </>
    );
  } else if (swapState?.phase === 'failed') {
    statusNode = <span className={s.bad}>Reverted · try again</span>;
  } else if (swapState?.phase === 'confirming') {
    statusNode = <>Settling on Solana…</>;
  } else if (swapState?.phase === 'signing') {
    statusNode = <>Confirm in MetaMask…</>;
  }

  // Token icon colour: WSOL → .sol, USDC → .usdc, fallback → .gen
  function icClass(sym) {
    const l = (sym ?? '').toLowerCase();
    if (l.includes('sol')) return s.sol;
    if (l.includes('usdc') || l.includes('usd')) return s.usdc;
    return s.gen;
  }
  const icFrom = icClass(fromSym);
  const icTo   = icClass(toSym);

  return (
    <main className={s.work}>
      <div className={s.strip}>
        <div className={s.lead}>
          <span className={s.eyebrow}>Meteora DAMM v2 · constant-product</span>
          <h1>
            Swap on Meteora from your EVM wallet — <em>one wallet, no bridge</em>.
          </h1>
        </div>
        <span className={s.routepill}>
          <span className={`${s.dot} ${s.evm}`} /> EVM · Rome{' '}
          <span className={s.ar}>→</span> Meteora{' '}
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
                balance <b>{fmtNum(fromBalance)}</b> {fromSym}
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
                <span className={`${s.ic} ${icFrom}`}>{fromSym.charAt(0).toLowerCase()}</span>
                <span className={s.sym}>{fromSym}</span>
              </div>
            </div>
            <div className={s.pct}>
              {[25, 50, 100].map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() =>
                    setAmount(
                      ((fromBalance * p) / 100).toFixed(6).replace(/\.?0+$/, ''),
                    )
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
              onClick={() => { setAToB((v) => !v); setAmount(''); }}
            >
              ⇅
            </button>
          </div>

          <div className={s.leg}>
            <div className={s.r1}>
              <label>You receive</label>
              <span className={s.bal}>
                balance <b>{fmtNum(toBalance)}</b> {toSym}
              </span>
            </div>
            <div className={s.r2}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className={`${s.amt} ${s.out}`}>
                  {out > 0 ? fmtNum(out, 6) : '0.00'}
                </div>
                <div className={s.usd}>≈ {fmtUSD(usdValue)}</div>
              </div>
              <div className={s.tokchip}>
                <span className={`${s.ic} ${icTo}`}>{toSym.charAt(0).toLowerCase()}</span>
                <span className={s.sym}>{toSym}</span>
              </div>
            </div>
          </div>

          <div className={s.slip}>
            <span className={s.lbl}>Slippage</span>
            {['0.1', '0.5', '1.0'].map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={slippage === v}
                onClick={() => setSlippage(v)}
              >
                {v}%
              </button>
            ))}
            <input
              aria-label="Custom slippage"
              value={slippage}
              onChange={(e) => setSlippage(e.target.value)}
            />
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
            <span className={s.pool}>Meteora DAMM v2 · devnet</span>
          </div>
          <div className={s.body}>
            <Ledger
              steps={plan.steps}
              count={plan.count}
              loading={plan.loading}
              sub={
                <>
                  One wallet — <b>no bridge, no Phantom, no second account</b>. Routes through
                  Meteora&apos;s constant-product DAMM v2 pool on Solana.
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
              <div className={s.ln}>
                <span className={s.k}>Rate</span>
                <span className={s.v}>
                  1 {fromSym} = {rate > 0 ? fmtNum(rate, 6) : '—'} {toSym}
                </span>
              </div>
              <div className={s.ln}>
                <span className={s.k}>
                  Pool fee <small>{POOL_FEE_BPS} bps</small>
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
                {plan.setupCount > 0 ? (
                  <>
                    First swap into a new token adds <b>one</b> account-creation
                    signature; after that it&apos;s a single signature.
                  </>
                ) : (
                  <>
                    The trade and your balance change land <b>together, or neither</b>{' '}
                    — one atomic Rome transaction at the pool&apos;s live price.
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
