'use client';
// Orca screen — act|see redesign. Swap wSOL ↔ wUSDC through the Orca Whirlpool
// (concentrated liquidity) on Solana, from one EVM wallet. Left: the trade
// form. Right: the live signature ledger. Quote + enforced otherAmountThreshold
// come from the pool's live sqrtPrice (lib/orca-quote.ts) — honest pool price,
// not an oracle; the swap reverts rather than fill below the shown floor.
//
// Working parts (pool state, swap submit, ATA init) are lifted from the tested
// Orca hooks; only the presentation is new.

import React, { useState } from 'react';
import { fmtUSD, fmtNum } from '../primitives';
import { Ledger } from '../design/Ledger';
import { ViaLink } from '../design/ViaLink';
import { useSignaturePlan } from '../../lib/use-signature-plan';
import { orcaSpotOut, orcaMinOut } from '../../lib/orca-quote';
import s from '../design/actsee.module.css';

export function Orca({
  wallet,
  onConnect,
  pool,
  pools = [],
  onSelectPool,
  poolState,
  ataBalancesByMint = {},
  onSwap,
  swapState,
  onCreateAta,
  ataInitState,
}) {
  const FEE_PPM = pool?.feePpm ?? 300; // pool trade fee (ppm)
  const FEE_BPS = FEE_PPM / 100; // 300 ppm → 3 bps
  const [aToB, setAToB] = useState(true); // true: wSOL → wUSDC (token A → B)
  const [amount, setAmount] = useState('1');
  const [slippage, setSlippage] = useState('0.5');

  // Cardo wrapper display names for the pool's WSOL / USDC pair.
  const fromSym = aToB ? 'wSOL' : 'wUSDC';
  const toSym = aToB ? 'wUSDC' : 'wSOL';
  const inDecimals = aToB ? pool.tokenDecimalsA : pool.tokenDecimalsB;
  const outDecimals = aToB ? pool.tokenDecimalsB : pool.tokenDecimalsA;
  const inMintHex = aToB ? pool.tokenMintA : pool.tokenMintB;
  const outMintHex = aToB ? pool.tokenMintB : pool.tokenMintA;

  const a = parseFloat(amount) || 0;
  const amountInRaw = BigInt(Math.floor(a * 10 ** inDecimals));
  const sqrtP = poolState?.sqrtPriceX64;
  const expectedOutRaw = sqrtP ? orcaSpotOut(sqrtP, aToB, amountInRaw, FEE_PPM) : 0n;
  const out = Number(expectedOutRaw) / 10 ** outDecimals;
  const slipBps = Math.floor((parseFloat(slippage) || 0) * 100);
  const minOutRaw = orcaMinOut(expectedOutRaw, slipBps);
  const minOut = Number(minOutRaw) / 10 ** outDecimals;
  const rate = a > 0 && out > 0 ? out / a : 0;

  const fromBalance = ataBalancesByMint[inMintHex] ?? 0;
  const toBalance = ataBalancesByMint[outMintHex] ?? 0;

  // The trade's USD value anchors to the USDC leg (reliably $1) — one side is
  // always wUSDC, so both legs read consistently (no oracle windfall).
  const usdValue = aToB ? out : a;

  const userEvm = wallet.connected && wallet.address ? wallet.address : undefined;
  const rawPlan = useSignaturePlan({ flow: 'swap', userEvmAddress: userEvm, outMintHex });
  // Same shape as a Meteora swap (create out ATA + swap); relabel for Orca.
  const steps = rawPlan.steps.map((st) =>
    st.id === 'swap'
      ? { ...st, label: 'Swap on Orca', detail: 'CPI → Orca whirlpool swap' }
      : st,
  );
  const plan = { ...rawPlan, steps };

  const noLiquidity = poolState && poolState.liquidity === 0n;
  const outAtaMissing = plan.setupCount > 0;
  const busy =
    (swapState && !['idle', 'success', 'failed'].includes(swapState.phase)) ||
    (ataInitState && !['idle', 'success', 'failed'].includes(ataInitState.phase));

  const liveFee = usdValue * (FEE_PPM / 1_000_000);
  const liveGas = 0.008;
  const liveRent = outAtaMissing ? 0.02 : 0;
  const liveTotal = liveFee + liveGas + liveRent;

  let ctaLabel = 'Swap on Orca';
  let ctaCaption = '1 signature · settles atomically on Solana';
  let ctaDisabled = false;
  let ctaOnClick;
  if (!wallet.connected) {
    ctaLabel = 'Connect wallet';
    ctaCaption = 'one wallet — no bridge, no Phantom';
    ctaOnClick = onConnect;
  } else if (poolState?.loading || sqrtP === undefined) {
    ctaLabel = 'Loading pool…';
    ctaDisabled = true;
  } else if (noLiquidity) {
    ctaLabel = 'No liquidity in pool';
    ctaDisabled = true;
  } else if (outAtaMissing) {
    ctaLabel = busy ? 'Creating account…' : `Create ${toSym} account`;
    ctaCaption = '1 signature · one-time, then swap in 1';
    ctaDisabled = busy;
    ctaOnClick = () => onCreateAta && onCreateAta(outMintHex);
  } else {
    ctaDisabled = busy || a <= 0 || a > fromBalance;
    ctaLabel = busy ? 'Swapping…' : a > fromBalance ? `Insufficient ${fromSym}` : 'Swap on Orca';
    ctaOnClick = () => onSwap && onSwap({ aToB, amountHuman: a, otherAmountThreshold: minOutRaw });
  }

  const status = swapState?.phase ?? ataInitState?.phase;
  let statusNode = <>Preview · this is exactly what your wallet will sign</>;
  if (swapState?.phase === 'success')
    statusNode = (
      <>
        <span className={s.ok}>✓ Settled on Orca</span>
        {swapState?.hash ? <> · <ViaLink hash={swapState.hash} /></> : null}
      </>
    );
  else if (ataInitState?.phase === 'success' && !outAtaMissing)
    statusNode = <span className={s.ok}>✓ Account ready — swap now</span>;
  else if (status === 'failed') statusNode = <span className={s.bad}>Reverted · try again</span>;
  else if (busy) statusNode = <>Confirm in MetaMask…</>;

  const icFrom = aToB ? s.sol : s.usdc;
  const icTo = aToB ? s.usdc : s.sol;

  return (
    <main className={s.work}>
      <div className={s.strip}>
        <div className={s.lead}>
          <span className={s.eyebrow}>Orca · concentrated liquidity</span>
          <h1>
            Swap on Orca from your EVM wallet — <em>one wallet, no bridge</em>.
          </h1>
        </div>
        <span className={s.routepill}>
          <span className={`${s.dot} ${s.evm}`} /> EVM · Rome <span className={s.ar}>→</span> Orca{' '}
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
                <span className={`${s.ic} ${icFrom}`}>{fromSym.charAt(1).toLowerCase()}</span>
                <span className={s.sym}>{fromSym}</span>
              </div>
            </div>
            <div className={s.pct}>
              {[25, 50, 100].map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setAmount(((fromBalance * p) / 100).toFixed(6).replace(/\.?0+$/, ''))}
                >
                  {p === 100 ? 'Max' : `${p}%`}
                </button>
              ))}
            </div>
          </div>

          <div className={s.flipwrap}>
            <button type="button" className={s.flip} aria-label="Flip" onClick={() => setAToB((v) => !v)}>
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
                <div className={`${s.amt} ${s.out}`}>{out > 0 ? fmtNum(out, 6) : '0.00'}</div>
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
            {['0.1', '0.5', '1.0'].map((v) => (
              <button key={v} type="button" aria-pressed={slippage === v} onClick={() => setSlippage(v)}>
                {v}%
              </button>
            ))}
            <input aria-label="Custom slippage" value={slippage} onChange={(e) => setSlippage(e.target.value)} />
          </div>

          {pools.length > 1 && (
            <div className={s.slip}>
              <span className={s.lbl}>Fee tier</span>
              {pools.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  aria-pressed={p.label === pool.label}
                  onClick={() => onSelectPool && onSelectPool(p.label)}
                >
                  {(p.feePpm / 10000).toFixed(2)}%
                </button>
              ))}
            </div>
          )}

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
            <span className={s.pool}>Orca Whirlpool · {pool?.label?.includes('devnet') ? 'CL' : 'CL'}</span>
          </div>
          <div className={s.body}>
            <Ledger
              steps={plan.steps}
              count={plan.count}
              loading={plan.loading}
              sub={
                <>
                  One wallet — <b>no bridge, no Phantom, no second account</b>. Routes through Orca&apos;s
                  concentrated-liquidity pool on Solana.
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
                  1 {fromSym} = {fmtNum(rate, 6)} {toSym}
                </span>
              </div>
              <div className={s.ln}>
                <span className={s.k}>
                  Pool fee <small>{FEE_BPS} bps</small>
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
                    First swap into a new token adds <b>one</b> account-creation signature; after that
                    it&apos;s a single signature.
                  </>
                ) : (
                  <>
                    The trade and your balance change land <b>together, or neither</b> — one atomic Rome
                    transaction at the pool&apos;s live price.
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
