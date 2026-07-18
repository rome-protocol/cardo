'use client';
// SwapPumpfun screen — act|see redesign. Pump.fun bonding-curve buy / sell
// against the pre-graduation virtual AMM, from one EVM wallet.
//
// Buy  spends native SOL (PDA lamports), receives memecoin.
// Sell burns memecoin from PDA-owned ATA, receives SOL.
//
// BUY/SELL modelled as .tabs (like Orca uses for pool-direction toggle).
// Quote math preserved verbatim from the original light-theme screen;
// only the presentation is new (act|see rig).

import React, { useEffect, useMemo, useState } from 'react';
import { fmtNum } from '../primitives';
import { Ledger } from '../design/Ledger';
import { TxHash } from '../design/Inline';
import { signaturePlan } from '../../lib/signature-plan';
import {
  quotePumpFunBuy,
  quotePumpFunSell,
} from '../../lib/pumpfun-curves';
import s from '../design/actsee.module.css';

const DEFAULT_SLIPPAGE_BPS = 500; // 5% — bonding curves are volatile

export function SwapPumpfun({
  wallet,
  onConnect,
  // Memecoin config — `{ mintBs58, symbol, decimals }`.
  config,
  // `useBondingCurve` output: `{ loading, curve, curveBs58, error }`.
  curveState,
  // User's memecoin SPL ATA balance (UI units).
  memecoinBalance = 0,
  // User's native SOL balance on Solana (PDA lamports / 1e9).
  solBalance = 0,
  // Submit handler: ({ side, amountHuman, quotedOutRaw, slippageBps }) → void
  onSwap,
  swapState,
  // Mint input change — page wrapper switches the URL param.
  onMintChange,
}) {
  const [side, setSide] = useState('buy'); // 'buy' | 'sell'
  const [amount, setAmount] = useState('');
  const [slippageBps, setSlippageBps] = useState(DEFAULT_SLIPPAGE_BPS);
  const [mintInput, setMintInput] = useState(config?.mintBs58 ?? '');

  useEffect(() => {
    setMintInput(config?.mintBs58 ?? '');
  }, [config?.mintBs58]);

  // Reset amount when switching sides.
  useEffect(() => {
    setAmount('');
  }, [side]);

  const isBuy = side === 'buy';
  const inSym = isBuy ? 'SOL' : config?.symbol ?? '—';
  const outSym = isBuy ? config?.symbol ?? '—' : 'SOL';
  const inDecimals = isBuy ? 9 : config?.decimals ?? 6;
  const outDecimals = isBuy ? config?.decimals ?? 6 : 9;
  const inBalance = isBuy ? solBalance : memecoinBalance;

  const amt = parseFloat(amount) || 0;
  const insufficient = amt > 0 && amt > inBalance;

  const phase = swapState?.phase ?? 'idle';
  const isWorking = phase === 'signing' || phase === 'confirming';

  const curve = curveState?.curve;
  const curveReady = !!curve;
  const noLiquidity =
    curveReady &&
    (curve.virtualTokenReserves === 0n || curve.virtualSolReserves === 0n);
  const graduated = curveReady && curve.complete;

  // Indicative output via the virtual-AMM quote (1% fee) — preserved from original.
  const quotedOutRaw = useMemo(() => {
    if (!curveReady || amt <= 0) return 0n;
    const inRaw = BigInt(Math.floor(amt * 10 ** inDecimals));
    if (inRaw <= 0n) return 0n;
    return isBuy
      ? quotePumpFunBuy(curve, inRaw)
      : quotePumpFunSell(curve, inRaw);
  }, [amt, isBuy, inDecimals, curve, curveReady]);

  const quotedOutHuman =
    quotedOutRaw > 0n ? Number(quotedOutRaw) / 10 ** outDecimals : 0;

  // Slippage-floored minimum out (same math as the route's onSwap handler).
  const slipMul = BigInt(10_000 - slippageBps);
  const minOutRaw = quotedOutRaw > 0n ? (quotedOutRaw * slipMul) / 10_000n : 0n;
  const minOutHuman = minOutRaw > 0n ? Number(minOutRaw) / 10 ** outDecimals : 0;

  // Signature ledger — pump.fun swap uses the 'swap' flow.
  // outAtaExists: undefined = optimistic (don't show setup step unless confirmed missing).
  const rawPlan = signaturePlan('swap', { outAtaExists: undefined });
  const steps = rawPlan.map((st) =>
    st.id === 'swap'
      ? {
          ...st,
          label: 'Swap on Pump.fun',
          detail: 'CPI → bonding-curve ' + side,
        }
      : st,
  );
  const count = steps.length;
  const loading = false; // plan is static for pumpfun (no live ATA probe in this hook)

  // CTA state machine.
  let ctaLabel = isBuy ? `Buy ${config?.symbol ?? 'memecoin'}` : `Sell ${config?.symbol ?? 'memecoin'}`;
  let ctaCaption = '1 signature · settles atomically on Solana';
  let ctaDisabled = false;
  let ctaOnClick;

  if (!wallet?.connected) {
    ctaLabel = 'Connect wallet';
    ctaCaption = 'one wallet — no bridge, no Phantom';
    ctaOnClick = onConnect;
  } else if (curveState?.loading) {
    ctaLabel = 'Loading curve…';
    ctaDisabled = true;
  } else if (graduated) {
    ctaLabel = 'Token graduated — use PumpSwap';
    ctaDisabled = true;
  } else if (noLiquidity) {
    ctaLabel = 'No liquidity in curve';
    ctaDisabled = true;
  } else {
    ctaDisabled =
      !curveReady ||
      amt <= 0 ||
      insufficient ||
      quotedOutRaw <= 0n ||
      isWorking;
    if (isWorking) ctaLabel = isBuy ? 'Buying…' : 'Selling…';
    else if (insufficient) ctaLabel = `Insufficient ${inSym}`;
    else if (amt <= 0) ctaLabel = 'Enter amount';
    ctaOnClick = () =>
      onSwap?.({
        side,
        amountHuman: amt,
        quotedOutRaw,
        slippageBps,
      });
  }

  // Status line.
  let statusNode = <>Preview · this is exactly what your wallet will sign</>;
  if (phase === 'signing') statusNode = <>Confirm in MetaMask…</>;
  else if (phase === 'confirming') statusNode = <>Settling on Solana…</>;
  else if (phase === 'success')
    statusNode = (
      <>
        <span className={s.ok}>✓ Settled on Pump.fun</span>
        {swapState?.hash ? (
          <>
            {' '}
            ·{' '}
            <TxHash hash={swapState.hash} />
          </>
        ) : null}
      </>
    );
  else if (phase === 'failed')
    statusNode = <span className={s.bad}>Reverted · try again</span>;

  const onMintCommit = (next) => {
    setMintInput(next);
    if (typeof onMintChange === 'function') onMintChange(next.trim());
  };

  return (
    <main className={s.work}>
      <div className={s.strip}>
        <div className={s.lead}>
          <span className={s.eyebrow}>Pump.fun · bonding curve</span>
          <h1>
            Trade <em>memecoins</em> — <em>pre-graduation, one signature</em>.
          </h1>
        </div>
        <span className={s.routepill}>
          <span className={`${s.dot} ${s.evm}`} /> EVM · Rome{' '}
          <span className={s.ar}>→</span> Pump.fun{' '}
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

          {/* BUY / SELL tabs */}
          <div className={s.tabs}>
            <button
              type="button"
              aria-pressed={isBuy}
              disabled={isWorking}
              onClick={() => setSide('buy')}
            >
              Buy {config?.symbol ?? 'memecoin'}
            </button>
            <button
              type="button"
              aria-pressed={!isBuy}
              disabled={isWorking}
              onClick={() => setSide('sell')}
            >
              Sell {config?.symbol ?? 'memecoin'}
            </button>
          </div>

          {/* Mint address field */}
          <div className={s.field}>
            <label>Memecoin mint</label>
            <input
              className={s.txt}
              type="text"
              value={mintInput}
              onChange={(e) => setMintInput(e.target.value)}
              onBlur={(e) => onMintCommit(e.target.value)}
              placeholder="Pump.fun mint address"
            />
          </div>

          {/* Graduated warning */}
          {graduated && (
            <div className={s.setupnote}>
              This token has graduated — trades route through PumpSwap.{' '}
              <button type="button" onClick={() => (window.location.href = '/swap-pumpswap')}>
                Use PumpSwap
              </button>
            </div>
          )}

          {/* You spend */}
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
                {insufficient && (
                  <div className={s.usd} style={{ color: 'var(--bad)' }}>
                    Exceeds {inSym} balance
                  </div>
                )}
              </div>
              <div className={s.tokchip}>
                <span className={`${s.ic} ${isBuy ? s.sol : s.gen}`}>
                  {inSym.charAt(0).toLowerCase()}
                </span>
                <span className={s.sym}>{inSym}</span>
              </div>
            </div>
            <div className={s.pct}>
              {[25, 50, 100].map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() =>
                    setAmount(
                      ((inBalance * p) / 100).toFixed(inDecimals > 6 ? 6 : 4).replace(/\.?0+$/, ''),
                    )
                  }
                >
                  {p === 100 ? 'Max' : `${p}%`}
                </button>
              ))}
            </div>
          </div>

          {/* You receive */}
          <div className={s.leg}>
            <div className={s.r1}>
              <label>You receive (indicative)</label>
            </div>
            <div className={s.r2}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className={`${s.amt} ${s.out}`}>
                  {quotedOutRaw > 0n ? fmtNum(quotedOutHuman, 6) : '0.00'}
                </div>
                <div className={s.usd}>
                  {curveState?.loading
                    ? 'loading curve…'
                    : !curveReady
                      ? curveState?.error || 'no curve found'
                      : noLiquidity
                        ? 'curve reserves are zero'
                        : 'virtual-AMM · 1% fee'}
                </div>
              </div>
              <div className={s.tokchip}>
                <span className={`${s.ic} ${!isBuy ? s.sol : s.gen}`}>
                  {outSym.charAt(0).toLowerCase()}
                </span>
                <span className={s.sym}>{outSym}</span>
              </div>
            </div>
          </div>

          {/* Slippage */}
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
            <span className={s.pool}>Pump.fun · bonding curve</span>
          </div>
          <div className={s.body}>
            <Ledger
              steps={steps}
              count={count}
              loading={loading}
              sub={
                <>
                  One wallet — <b>no bridge, no Phantom, no second account</b>. Calls Pump.fun&apos;s
                  bonding-curve program on Solana.
                </>
              }
            />
            <div className={s.outcome}>
              <div className={`${s.ln} ${s.get}`}>
                <span className={s.k}>You receive at least</span>
                <span className={s.v}>
                  {minOutRaw > 0n ? fmtNum(minOutHuman, 6) : '—'} {outSym}
                </span>
              </div>
              <div className={s.ln}>
                <span className={s.k}>Side</span>
                <span className={s.v}>{isBuy ? 'Buy' : 'Sell'}</span>
              </div>
              <div className={s.ln}>
                <span className={s.k}>
                  Curve fee <small>100 bps</small>
                </span>
                <span className={s.v}>1%</span>
              </div>
              <div className={s.ln}>
                <span className={s.k}>Slippage guard</span>
                <span className={s.v}>{slippageBps / 100}%</span>
              </div>
              {curve && (
                <div className={s.ln}>
                  <span className={s.k}>Real reserves</span>
                  <span className={s.v}>
                    {(Number(curve.realSolReserves) / 1e9).toFixed(3)} SOL
                  </span>
                </div>
              )}
              <div className={s.note}>
                {isBuy ? (
                  <>
                    SOL is debited from your PDA lamports; memecoin lands in your{' '}
                    <b>PDA-owned ATA</b> — all in one atomic Rome transaction.
                  </>
                ) : (
                  <>
                    Memecoin is burned from your ATA; SOL credits your{' '}
                    <b>PDA lamports</b> — atomically, or neither side settles.
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
