'use client';
// Lend screen — act|see redesign (Kamino). Left: Supply/Borrow form. Right:
// the live signature ledger. Honest state: the one-time SETUP (lending account
// + obligation) is executable and shown as the first ledger steps; the
// supply/borrow WRITE is disabled pending a calldata rebuild against klend's
// verified Anchor source (every submit currently reverts), so the action CTA
// is gated with a clear note. Read-only position shows on-chain truth only.
//
// All working parts (setup, action submit, preflight, live position) are lifted
// from the data layer (app/lend/page.tsx) unchanged.

import React, { useState, useEffect } from 'react';
import { fmtUSD, fmtPct, fmtNum } from '../primitives';
import { Ledger } from '../design/Ledger';
import { TxError, TxHash } from '../design/Inline';
import s from '../design/actsee.module.css';

// Display metadata for the reserves Cardo wires on Rome. USDC + SOL are the
// live-market reserves; BTC/JTO are shown but not selectable (no market).
const RESERVES = [
  { sym: 'USDC', name: 'USD Coin', supplyApy: 8.24, borrowApy: 11.4, price: 1 },
  { sym: 'SOL', name: 'Solana', supplyApy: 5.12, borrowApy: 8.6, price: 149.22 },
  { sym: 'BTC', name: 'Bitcoin', supplyApy: 0.41, borrowApy: 2.8, price: 71440, pending: true },
  { sym: 'JTO', name: 'Jito', supplyApy: 0, borrowApy: 0, price: 2.8, pending: true },
];

function iconClass(sym) {
  const u = (sym || '').toUpperCase();
  if (u.includes('USD')) return s.usdc;
  if (u.includes('SOL')) return s.sol;
  if (u.includes('BTC') || u.includes('ETH')) return s.eth;
  return s.gen;
}

function setupPhaseLabel(phase) {
  if (phase === 'creating-metadata') return 'Sign 1 · lending account…';
  if (phase === 'confirming-metadata') return '1 confirming…';
  if (phase === 'creating-obligation') return 'Sign 2 · obligation…';
  if (phase === 'confirming-obligation') return '2 confirming…';
  return 'Working…';
}

const Lend = ({
  wallet,
  onConnect,
  onQuoteInputsChange,
  setupRequired,
  setupState,
  onSetup,
  onExecAction, // ({capability, reserveSym, amountHuman}) — wired; action gated below
  livePosition,
  obligationLoading,
  signaturePlan,
}) => {
  const [mode, setMode] = useState('supply'); // supply | borrow
  const [reserveSym, setReserveSym] = useState('USDC');
  const [amount, setAmount] = useState('1');
  const [showPicker, setShowPicker] = useState(false);

  const reserve = RESERVES.find((r) => r.sym === reserveSym) ?? RESERVES[0];
  const a = parseFloat(amount) || 0;
  const apy = mode === 'supply' ? reserve.supplyApy : reserve.borrowApy;

  useEffect(() => {
    if (typeof onQuoteInputsChange !== 'function') return;
    onQuoteInputsChange({ capability: mode, reserveSym, amount: a });
  }, [onQuoteInputsChange, mode, reserveSym, a]);

  // Live on-chain position (null = none / not connected). No mock fallback.
  const position = wallet.connected ? livePosition : null;
  const suppliedUSD = position
    ? position.supplied.reduce((sum, p) => sum + p.amt * (RESERVES.find((r) => r.sym === p.sym)?.price || 1), 0)
    : 0;
  const borrowedUSD = position
    ? position.borrowed.reduce((sum, p) => sum + p.amt * (RESERVES.find((r) => r.sym === p.sym)?.price || 1), 0)
    : 0;

  const setupBusy =
    setupState && !['idle', 'success', 'failed'].includes(setupState.phase);

  // CTA state machine: connect → set up (executable) → supply/borrow (gated).
  let ctaLabel = mode === 'supply' ? 'Supply' : 'Borrow';
  let ctaCaption = 'Kamino write is being rebuilt — setup works today';
  let ctaDisabled = true;
  let ctaOnClick = undefined;
  if (!wallet.connected) {
    ctaLabel = 'Connect wallet';
    ctaCaption = 'one wallet — no bridge, no Phantom';
    ctaDisabled = false;
    ctaOnClick = onConnect;
  } else if (setupRequired) {
    ctaLabel = setupBusy ? setupPhaseLabel(setupState.phase) : 'Set up lending account';
    ctaCaption = '2 signatures · one-time, then lend in 1';
    ctaDisabled = setupBusy;
    ctaOnClick = onSetup;
  }

  const plan = signaturePlan ?? { steps: [], count: 1, setupCount: 0, loading: false };

  return (
    <>
      <main className={s.work}>
        <div className={s.strip}>
          <div className={s.lead}>
            <span className={s.eyebrow}>Kamino · lending on Solana</span>
            <h1>
              Lend into Solana markets — <em>from one wallet</em>.
            </h1>
          </div>
          <span className={s.routepill}>
            <span className={`${s.dot} ${s.evm}`} /> EVM · Rome <span className={s.ar}>→</span> Kamino{' '}
            <span className={`${s.dot} ${s.sol}`} />
          </span>
        </div>

        <div className={s.rig}>
          {/* ── ACT ── */}
          <form className={`${s.col} ${s.act}`} autoComplete="off" onSubmit={(e) => { e.preventDefault(); if (ctaOnClick) ctaOnClick(); }}>
            <div className={s.colhd}>
              <span className={s.sd} /> You do this
            </div>

            <div className={s.tabs}>
              <button type="button" aria-pressed={mode === 'supply'} onClick={() => setMode('supply')}>
                Supply
              </button>
              <button type="button" aria-pressed={mode === 'borrow'} onClick={() => setMode('borrow')}>
                Borrow
              </button>
            </div>

            <div className={s.leg}>
              <div className={s.r1}>
                <label>You {mode}</label>
                <span className={s.bal}>
                  {mode === 'supply' ? 'supply' : 'borrow'} APY <b>{fmtPct(apy)}</b>
                </span>
              </div>
              <div className={s.r2}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <input
                    className={s.amt}
                    inputMode="decimal"
                    aria-label="Amount"
                    placeholder="0.00"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                  <div className={s.usd}>≈ {fmtUSD(a * reserve.price)}</div>
                </div>
                <button type="button" className={s.tokchip} onClick={() => setShowPicker(true)}>
                  <span className={`${s.ic} ${iconClass(reserveSym)}`}>{reserveSym.charAt(0).toLowerCase()}</span>
                  <span className={s.sym}>{reserveSym}</span>
                  <span className={s.car}>▾</span>
                </button>
              </div>
            </div>

            <div className={s.leg}>
              <div className={s.r1}>
                <label>Market</label>
                <span className={s.bal}>Kamino main · devnet</span>
              </div>
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
              <span className={s.pool}>Kamino main · devnet</span>
            </div>
            <div className={s.body}>
              <Ledger
                steps={plan.steps}
                count={plan.count}
                loading={plan.loading}
                sub={
                  <>
                    Kamino needs a <b>one-time</b> lending account + obligation. After that, lending is
                    a single signature.
                  </>
                }
              />

              <div className={s.outcome}>
                {position ? (
                  <>
                    <div className={`${s.ln} ${s.get}`}>
                      <span className={s.k}>You&apos;ve supplied</span>
                      <span className={s.v}>{fmtUSD(suppliedUSD)}</span>
                    </div>
                    <div className={s.ln}>
                      <span className={s.k}>You&apos;ve borrowed</span>
                      <span className={s.v}>{fmtUSD(borrowedUSD)}</span>
                    </div>
                  </>
                ) : (
                  <div className={s.ln}>
                    <span className={s.k}>Your position</span>
                    <span className={s.v}>
                      {wallet.connected && !obligationLoading ? 'none yet' : '—'}
                    </span>
                  </div>
                )}
                <div className={s.ln}>
                  <span className={s.k}>
                    {mode === 'supply' ? 'Supply' : 'Borrow'} APY <small>{reserve.sym}</small>
                  </span>
                  <span className={s.v}>{fmtPct(apy)}</span>
                </div>
                <div className={s.note}>
                  Setup (lending account + obligation) is live today. The supply/borrow write is being
                  rebuilt against klend&apos;s verified Anchor source — until it lands, use{' '}
                  <a href="https://app.kamino.finance" target="_blank" rel="noreferrer">
                    app.kamino.finance
                  </a>{' '}
                  to lend on this market.
                </div>
              </div>
            </div>
            <div className={s.status}>
              {setupState && setupState.phase === 'failed' ? (
                <TxError error={setupState.error} />
              ) : setupState && setupState.phase === 'success' ? (
                <><span className={s.ok}>✓ Lending account ready</span>{setupState?.hash ? <> · <TxHash hash={setupState.hash} /></> : null}</>
              ) : (
                <>Preview · this is exactly what your wallet will sign</>
              )}
            </div>
          </section>
        </div>
      </main>

      {showPicker && (
        <ReservePicker
          current={reserveSym}
          onPick={(sym) => {
            setReserveSym(sym);
            setShowPicker(false);
          }}
          onClose={() => setShowPicker(false)}
        />
      )}
    </>
  );
};

const ReservePicker = ({ current, onPick, onClose }) => (
  <div className={s.scrim} onClick={onClose}>
    <div className={s.picker} onClick={(e) => e.stopPropagation()}>
      <span className={s.eyebrow}>Select reserve</span>
      <div className={s.list} style={{ marginTop: 14 }}>
        {RESERVES.map((r) => (
          <button
            key={r.sym}
            type="button"
            className={s.row}
            disabled={r.sym === current || r.pending}
            onClick={() => onPick(r.sym)}
          >
            <span className={`${s.ic} ${iconClass(r.sym)}`}>{r.sym.charAt(0).toLowerCase()}</span>
            <div style={{ minWidth: 0 }}>
              <div className={s.sym}>
                {r.sym} {r.pending ? '· soon' : ''}
              </div>
              <div className={s.nm}>{r.name}</div>
            </div>
            <span className={s.bl}>{fmtPct(r.supplyApy)}</span>
          </button>
        ))}
      </div>
    </div>
  </div>
);

export { Lend };
