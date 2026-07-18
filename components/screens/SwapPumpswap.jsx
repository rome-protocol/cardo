'use client';
// SwapPumpswap screen — act|see redesign. Buy / sell against a PumpSwap AMM
// pool on Solana from one EVM wallet.
//
// buy  — spend quote (WWSOL), receive base (WMEME).
// sell — spend base  (WMEME), receive quote (WWSOL).
//
// Quote is constant-product with the published 0.25% fee via
// quotePumpSwapBuy / quotePumpSwapSell. Slippage guard (default 5%,
// memecoin-appropriate) is enforced by the on-chain PumpSwap ix — the tx
// reverts rather than fill below the shown floor.

import React, { useEffect, useMemo, useState } from 'react';
import { fmtNum } from '../primitives';
import { Ledger } from '../design/Ledger';
import { TxError, TxHash } from '../design/Inline';
import { signaturePlan } from '../../lib/signature-plan';
import { quotePumpSwapBuy, quotePumpSwapSell } from '../../lib/pumpswap-pools';
import { compactNum } from '../../lib/stats-format';
import s from '../design/actsee.module.css';

// Default to a wide slippage tolerance — PumpSwap pools are memecoin-tier.
const DEFAULT_SLIPPAGE_BPS = 500; // 5%

export function SwapPumpswap({
  wallet,
  onConnect,
  pool,
  poolState,
  ataBalancesByMint = {},
  onSwap,
  swapState,
}) {
  const [side, setSide] = useState('buy'); // 'buy' = quote→base, 'sell' = base→quote
  const [amount, setAmount] = useState('');
  const [slippageBps, setSlippageBps] = useState(DEFAULT_SLIPPAGE_BPS);

  const isBuy = side === 'buy';
  const inSym  = isBuy ? pool?.quote.symbol : pool?.base.symbol;
  const outSym = isBuy ? pool?.base.symbol  : pool?.quote.symbol;
  const inMint    = isBuy ? pool?.quote.mintBs58 : pool?.base.mintBs58;
  const inDecimals  = isBuy ? pool?.quote.decimals : pool?.base.decimals;
  const outDecimals = isBuy ? pool?.base.decimals  : pool?.quote.decimals;
  const inBalance = inMint ? (ataBalancesByMint[inMint] ?? 0) : 0;

  const amt = parseFloat(amount) || 0;
  const insufficient = amt > 0 && amt > inBalance;

  const phase = swapState?.phase ?? 'idle';
  const isWorking = phase === 'signing' || phase === 'confirming';

  const reservesReady =
    poolState?.baseReserve != null && poolState?.quoteReserve != null;
  const noLiquidity =
    reservesReady &&
    (poolState.baseReserve === 0n || poolState.quoteReserve === 0n);

  // Indicative output — constant-product with the published 0.25% total fee.
  const quotedOutRaw = useMemo(() => {
    if (!reservesReady || amt <= 0 || !inDecimals) return 0n;
    const inRaw = BigInt(Math.floor(amt * 10 ** inDecimals));
    if (inRaw <= 0n) return 0n;
    return isBuy
      ? quotePumpSwapBuy(poolState.baseReserve, poolState.quoteReserve, inRaw)
      : quotePumpSwapSell(poolState.baseReserve, poolState.quoteReserve, inRaw);
  }, [amt, isBuy, inDecimals, poolState?.baseReserve, poolState?.quoteReserve, reservesReady]);

  const quotedOutHuman =
    outDecimals !== undefined && quotedOutRaw > 0n
      ? Number(quotedOutRaw) / 10 ** outDecimals
      : 0;

  // Slippage floor shown in the SEE panel.
  const minOutRaw = quotedOutRaw > 0n
    ? (quotedOutRaw * BigInt(10_000 - slippageBps)) / 10_000n
    : 0n;
  const minOutHuman =
    outDecimals !== undefined && minOutRaw > 0n
      ? Number(minOutRaw) / 10 ** outDecimals
      : 0;

  // Pool liquidity (fixed base/quote order — base=memecoin, quote=WWSOL —
  // independent of buy/sell side). PumpSwap exposes raw vault reserves only.
  const baseLiqHuman =
    poolState?.baseReserve != null && pool?.base?.decimals != null
      ? Number(poolState.baseReserve) / 10 ** pool.base.decimals
      : null;
  const quoteLiqHuman =
    poolState?.quoteReserve != null && pool?.quote?.decimals != null
      ? Number(poolState.quoteReserve) / 10 ** pool.quote.decimals
      : null;

  // Reset the amount field when the user flips direction to avoid stale decimals.
  useEffect(() => {
    setAmount('');
  }, [side]);

  // Signature ledger — relabel the swap step for PumpSwap.
  const steps = signaturePlan('swap', { outAtaExists: undefined }).map((st) =>
    st.id === 'swap'
      ? { ...st, label: 'Swap on PumpSwap', detail: 'CPI → PumpSwap AMM' }
      : st,
  );
  const count = steps.length;

  // CTA state machine.
  let ctaLabel   = `${isBuy ? 'Buy' : 'Sell'} ${pool?.base.symbol ?? 'token'}`;
  let ctaCaption = '1 signature · settles atomically on Solana';
  let ctaDisabled = false;
  let ctaOnClick;

  if (!wallet?.connected) {
    ctaLabel   = 'Connect wallet';
    ctaCaption = 'one wallet — no bridge, no Phantom';
    ctaOnClick = onConnect;
  } else if (!reservesReady) {
    ctaLabel    = poolState?.error ? 'Pool error' : 'Loading pool…';
    ctaDisabled = true;
  } else if (noLiquidity) {
    ctaLabel    = 'No liquidity in pool';
    ctaDisabled = true;
  } else if (amt <= 0) {
    ctaLabel    = 'Enter amount';
    ctaDisabled = true;
  } else if (insufficient) {
    ctaLabel    = `Insufficient ${inSym}`;
    ctaDisabled = true;
  } else if (quotedOutRaw <= 0n) {
    ctaLabel    = 'Amount too small';
    ctaDisabled = true;
  } else if (isWorking) {
    ctaLabel    = 'Swapping…';
    ctaDisabled = true;
  } else {
    ctaOnClick = () =>
      onSwap?.({ side, amountHuman: amt, quotedOutRaw, quotedOutHuman, slippageBps });
  }

  // SEE-column status node.
  let statusNode = <>Preview · this is exactly what your wallet will sign</>;
  if (phase === 'success') {
    statusNode = (
      <>
        <span className={s.ok}>✓ Settled on PumpSwap</span>
        {swapState?.hash ? <> · <TxHash hash={swapState.hash} /></> : null}
      </>
    );
  } else if (phase === 'signing') {
    statusNode = <>Confirm in MetaMask…</>;
  } else if (phase === 'confirming') {
    statusNode = <>Settling on Solana…</>;
  } else if (phase === 'failed') {
    statusNode = swapState?.error ? (
      <TxError error={swapState.error} />
    ) : (
      <span className={s.bad}>Reverted · try again</span>
    );
  }

  // Token icon class — base=generic memecoin, quote=sol/wSOL.
  const icIn  = isBuy ? s.sol : s.gen;
  const icOut = isBuy ? s.gen : s.sol;
  const icInChar  = (inSym  ?? 'm').charAt(1)?.toLowerCase() || 's';
  const icOutChar = (outSym ?? 'm').charAt(1)?.toLowerCase() || 's';

  return (
    <main className={s.work}>
      <div className={s.strip}>
        <div className={s.lead}>
          <span className={s.eyebrow}>PumpSwap · constant-product AMM</span>
          <h1>
            Swap on PumpSwap from your EVM wallet — <em>one wallet, no bridge</em>.
          </h1>
        </div>
        <span className={s.routepill}>
          <span className={`${s.dot} ${s.evm}`} /> EVM · Rome <span className={s.ar}>→</span> PumpSwap{' '}
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

          {/* BUY / SELL tab switcher */}
          <div className={s.tabs}>
            <button
              type="button"
              aria-pressed={isBuy}
              disabled={isWorking}
              onClick={() => setSide('buy')}
            >
              Buy {pool?.base.symbol ?? 'base'}
            </button>
            <button
              type="button"
              aria-pressed={!isBuy}
              disabled={isWorking}
              onClick={() => setSide('sell')}
            >
              Sell {pool?.base.symbol ?? 'base'}
            </button>
          </div>

          <div className={s.leg}>
            <div className={s.r1}>
              <label>You spend</label>
              <span className={s.bal}>
                balance <b>{fmtNum(inBalance, 4)}</b> {inSym}
              </span>
            </div>
            <div className={s.r2}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <input
                  className={s.amt}
                  inputMode="decimal"
                  aria-label="Spend amount"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </div>
              <div className={s.tokchip}>
                <span className={`${s.ic} ${icIn}`}>{icInChar}</span>
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
              onClick={() => setSide((v) => (v === 'buy' ? 'sell' : 'buy'))}
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
                  {quotedOutRaw > 0n ? fmtNum(quotedOutHuman, 6) : '0.00'}
                </div>
                <div className={s.usd}>
                  {reservesReady ? (
                    noLiquidity ? (
                      'pool reserves are zero'
                    ) : (
                      'constant-product · 0.25% fee'
                    )
                  ) : poolState?.error ? (
                    <>pool error: <TxError error={poolState.error} /></>
                  ) : (
                    'loading reserves…'
                  )}
                </div>
              </div>
              <div className={s.tokchip}>
                <span className={`${s.ic} ${icOut}`}>{icOutChar}</span>
                <span className={s.sym}>{outSym}</span>
              </div>
            </div>
          </div>

          {/* Slippage control */}
          <div className={s.slip}>
            <span className={s.lbl}>Slippage</span>
            {[100, 300, 500].map((bps) => (
              <button
                key={bps}
                type="button"
                aria-pressed={slippageBps === bps}
                onClick={() => setSlippageBps(bps)}
              >
                {bps / 100}%
              </button>
            ))}
            <input
              aria-label="Custom slippage %"
              value={(slippageBps / 100).toString()}
              onChange={(e) => {
                const pct = parseFloat(e.target.value) || 0;
                setSlippageBps(Math.max(1, Math.min(2000, Math.round(pct * 100))));
              }}
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
            <span className={s.pool}>PumpSwap AMM · 0.25% fee</span>
          </div>
          <div className={s.body}>
            <Ledger
              steps={steps}
              count={count}
              loading={false}
              sub={
                <>
                  One wallet — <b>no bridge, no Phantom, no second account</b>. Routes through
                  PumpSwap&apos;s constant-product pool on Solana.
                </>
              }
            />
            <div className={s.outcome}>
              <div className={`${s.ln} ${s.get}`}>
                <span className={s.k}>You receive at least</span>
                <span className={s.v}>
                  {minOutHuman > 0 ? fmtNum(minOutHuman, 6) : '0.00'} {outSym}
                </span>
              </div>
              <div className={s.ln}>
                <span className={s.k}>Pool liquidity</span>
                <span className={s.v}>
                  {baseLiqHuman != null ? `${compactNum(baseLiqHuman)} ${pool?.base?.symbol ?? ''}` : '—'} · {quoteLiqHuman != null ? `${compactNum(quoteLiqHuman)} ${pool?.quote?.symbol ?? ''}` : '—'}
                </span>
              </div>
              <div className={s.ln}>
                <span className={s.k}>Slippage guard</span>
                <span className={s.v}>{(slippageBps / 100).toFixed(2)}%</span>
              </div>
              <div className={s.ln}>
                <span className={s.k}>
                  Pool fee <small>25 bps</small>
                </span>
                <span className={s.v}>0.25%</span>
              </div>
              {pool && (
                <div className={s.ln}>
                  <span className={s.k}>Pool</span>
                  <span className={s.v} style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>
                    {pool.poolBs58.slice(0, 6)}…{pool.poolBs58.slice(-4)}
                  </span>
                </div>
              )}
              <div className={s.note}>
                The trade and your balance change land{' '}
                <b>together, or neither</b> — one atomic Rome transaction at the
                pool&apos;s live price. PumpSwap pools are memecoin-tier; the default
                5% slippage guard is intentional.
              </div>
            </div>
          </div>
          <div className={s.status}>{statusNode}</div>
        </section>
      </div>
    </main>
  );
}
