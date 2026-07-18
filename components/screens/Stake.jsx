'use client';
// Stake screen — act|see redesign. Stake native SOL (your Rome PDA's Solana
// balance) into a liquid-stake token via spl-stake-pool DepositSol. Left: the
// stake form. Right: the live signature ledger — fresh = 2 (create LST account
// + stake), warm = 1. The ledger is built in-screen from the ATA pre-flight the
// page already polls (ataStatusByMint), so no double-probing.
//
// Working parts (pools, balances, ATA setup, deposit) lifted from the data
// layer (app/stake/page.tsx) unchanged.

import React, { useState, useEffect } from 'react';
import { fmtNum } from '../primitives';
import { Ledger } from '../design/Ledger';
import { TxError, TxHash } from '../design/Inline';
import { signaturePlan } from '../../lib/signature-plan';
import { statusToFlag } from '../../lib/signature-plan-live';
import { lamportsToSol, compactNum } from '../../lib/stats-format';
import s from '../design/actsee.module.css';

const Stake = ({
  wallet,
  onConnect,
  pools = [],
  solBalance = 0,
  lstBalances = {},
  ataStatusByMint = {},
  onSetup,
  ataInitState,
  onSelectPool,
  onDeposit,
  depositState,
  poolStats = {},
  tab = 'main',
  onTab,
  children,
}) => {
  const enabled = pools.filter((p) => p.enabled !== false);
  const [sym, setSym] = useState(enabled[0]?.symbol ?? pools[0]?.symbol ?? '');
  const [amount, setAmount] = useState('1');
  const [showPicker, setShowPicker] = useState(false);

  const entry = pools.find((p) => p.symbol === sym) ?? pools[0];
  const mintHex = entry?.pool?.poolMint;
  const a = parseFloat(amount) || 0;
  const lstBalance = mintHex ? (lstBalances[mintHex] ?? 0) : 0;
  const ataStatus = mintHex ? ataStatusByMint[mintHex] : undefined;

  // Live pool stats (real exchange rate + TVL from the StakePool reserves).
  const stat = mintHex ? poolStats[mintHex] : undefined;
  const lstPerSol = stat?.rate?.lstPerSol ?? null;     // LST minted per 1 SOL
  const solPerLst = stat?.rate?.solPerLst ?? null;     // 1 LST is worth this many SOL
  const estLstOut = lstPerSol != null ? a * lstPerSol : a;
  const tvlSol = stat ? lamportsToSol(stat.totalLamports) : 0;

  // Notify the page so it scopes the ATA pre-flight to the selected mint.
  useEffect(() => {
    if (typeof onSelectPool === 'function' && entry) onSelectPool(entry);
  }, [onSelectPool, entry]);

  // Live ledger from the page's ATA pre-flight (no second probe).
  const steps = signaturePlan('stake', { outAtaExists: statusToFlag(ataStatus) });
  const plan = {
    steps,
    count: steps.length,
    loading: wallet.connected && !!mintHex && (ataStatus === undefined || ataStatus === 'unknown'),
  };

  const ataMissing = ataStatus === 'missing';
  const busy =
    (ataInitState && !['idle', 'success', 'failed'].includes(ataInitState.phase)) ||
    (depositState && !['idle', 'success', 'failed'].includes(depositState.phase));

  let ctaLabel = 'Stake';
  let ctaCaption = '1 signature · settles atomically on Solana';
  let ctaDisabled = false;
  let ctaOnClick;
  if (!wallet.connected) {
    ctaLabel = 'Connect wallet';
    ctaCaption = 'one wallet — no bridge, no Phantom';
    ctaOnClick = onConnect;
  } else if (ataMissing) {
    ctaLabel = busy ? 'Creating account…' : `Create ${sym} account`;
    ctaCaption = '1 signature · one-time, then stake in 1';
    ctaDisabled = busy;
    ctaOnClick = () => onSetup && onSetup({ entry });
  } else {
    ctaLabel = busy ? 'Staking…' : a > solBalance ? 'Insufficient SOL' : 'Stake';
    ctaDisabled = busy || a <= 0 || a > solBalance;
    ctaOnClick = () => onDeposit && onDeposit({ entry, amountSol: a });
  }

  const status = depositState?.phase ?? ataInitState?.phase;
  let statusNode = <>Preview · this is exactly what your wallet will sign</>;
  if (depositState?.phase === 'success') statusNode = <><span className={s.ok}>✓ Staked</span>{depositState?.hash ? <> · <TxHash hash={depositState.hash} /></> : null}</>;
  else if (ataInitState?.phase === 'success' && !ataMissing) statusNode = <span className={s.ok}>✓ Account ready — stake now</span>;
  else if (status === 'failed') statusNode = <TxError error={depositState?.error ?? ataInitState?.error} />;
  else if (busy) statusNode = <>Confirm in MetaMask…</>;

  return (
    <>
      <main className={s.work}>
        <div className={s.strip}>
          <div className={s.lead}>
            <span className={s.eyebrow}>Liquid staking on Solana</span>
            <h1>
              Stake SOL, stay liquid — <em>from your EVM wallet</em>.
            </h1>
          </div>
          <span className={s.routepill}>
            <span className={`${s.dot} ${s.evm}`} /> EVM · Rome <span className={s.ar}>→</span> Stake pool{' '}
            <span className={`${s.dot} ${s.sol}`} />
          </span>
        </div>

        {onTab && (
          <div className={s.tabs}>
            <button type="button" aria-pressed={tab === 'main'} onClick={() => onTab('main')}>Stake</button>
            <button type="button" aria-pressed={tab === 'unstake'} onClick={() => onTab('unstake')}>Unstake</button>
          </div>
        )}

        {tab === 'unstake' && children ? children : (
        <div className={s.rig}>
          <form className={`${s.col} ${s.act}`} autoComplete="off" onSubmit={(e) => { e.preventDefault(); if (ctaOnClick) ctaOnClick(); }}>
            <div className={s.colhd}>
              <span className={s.sd} /> You do this
            </div>

            <div className={s.leg}>
              <div className={s.r1}>
                <label>You stake</label>
                <span className={s.bal}>
                  balance <b>{fmtNum(solBalance)}</b> SOL
                </span>
              </div>
              <div className={s.r2}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <input
                    className={s.amt}
                    inputMode="decimal"
                    aria-label="Stake amount"
                    placeholder="0.00"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                  <div className={s.usd}>SOL on Solana · your Rome account</div>
                </div>
                <div className={s.tokchip}>
                  <span className={`${s.ic} ${s.sol}`}>◎</span>
                  <span className={s.sym}>SOL</span>
                </div>
              </div>
              <div className={s.pct}>
                {[25, 50, 100].map((p) => (
                  <button key={p} type="button" onClick={() => setAmount(((solBalance * p) / 100).toFixed(6).replace(/\.?0+$/, ''))}>
                    {p === 100 ? 'Max' : `${p}%`}
                  </button>
                ))}
              </div>
            </div>

            <div className={s.flipwrap}>
              <span className={s.flip} aria-hidden>↓</span>
            </div>

            <div className={s.leg}>
              <div className={s.r1}>
                <label>You receive</label>
                <span className={s.bal}>
                  balance <b>{fmtNum(lstBalance)}</b> {sym}
                </span>
              </div>
              <div className={s.r2}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className={`${s.amt} ${s.out}`}>{a > 0 ? `≈ ${fmtNum(estLstOut, 4)}` : '0.00'}</div>
                  <div className={s.usd}>
                    {solPerLst != null ? `1 ${sym} = ${fmtNum(solPerLst, 4)} SOL` : 'rate read live at submit'}
                  </div>
                </div>
                <button type="button" className={s.tokchip} onClick={() => enabled.length > 1 && setShowPicker(true)}>
                  <span className={`${s.ic} ${s.sol}`}>{(sym[0] || 'L').toLowerCase()}</span>
                  <span className={s.sym}>{sym}</span>
                  {enabled.length > 1 && <span className={s.car}>▾</span>}
                </button>
              </div>
            </div>

            <div className={s['cta-wrap']}>
              <button className={s.cta} type="submit" disabled={ctaDisabled}>
                <span>{ctaLabel}</span>
                <span className={s.sig}>{ctaCaption}</span>
              </button>
            </div>
          </form>

          <section className={`${s.col} ${s.see}`}>
            <div className={s.colhd}>
              <span className={s.sd} /> What will happen
              <span className={s.pool}>{entry?.name ?? 'Stake pool'}</span>
            </div>
            <div className={s.body}>
              <Ledger
                steps={plan.steps}
                count={plan.count}
                loading={plan.loading}
                sub={
                  <>
                    You get a liquid stake token you can <b>swap or lend anytime</b> — no unbonding
                    wait to move it.
                  </>
                }
              />
              <div className={s.outcome}>
                <div className={`${s.ln} ${s.get}`}>
                  <span className={s.k}>You receive</span>
                  <span className={s.v}>
                    ~{fmtNum(estLstOut, 4)} {sym}
                  </span>
                </div>
                <div className={s.ln}>
                  <span className={s.k}>Exchange rate</span>
                  <span className={s.v}>{solPerLst != null ? `1 ${sym} = ${fmtNum(solPerLst, 4)} SOL` : '—'}</span>
                </div>
                <div className={s.ln}>
                  <span className={s.k}>Pool TVL <small>staked</small></span>
                  <span className={s.v}>{tvlSol > 0 ? `◎ ${compactNum(tvlSol)}` : '—'}</span>
                </div>
                {lstBalance > 0 && (
                  <div className={s.ln}>
                    <span className={s.k}>Your {sym} <small>≈ SOL</small></span>
                    <span className={s.v}>{fmtNum(lstBalance, 4)} <small>≈ ◎ {fmtNum(lstBalance * (solPerLst ?? 1), 4)}</small></span>
                  </div>
                )}
                <div className={s.note}>
                  First stake creates your {sym} account (<b>one</b> extra signature); after that,
                  staking is a single signature. The stake token is yours immediately — no lockup to
                  move it.
                </div>
              </div>
            </div>
            <div className={s.status}>{statusNode}</div>
          </section>
        </div>
        )}
      </main>

      {showPicker && (
        <div className={s.scrim} onClick={() => setShowPicker(false)}>
          <div className={s.picker} onClick={(e) => e.stopPropagation()}>
            <span className={s.eyebrow}>Select stake pool</span>
            <div className={s.list} style={{ marginTop: 14 }}>
              {enabled.map((p) => (
                <button key={p.symbol} type="button" className={s.row} disabled={p.symbol === sym} onClick={() => { setSym(p.symbol); setShowPicker(false); }}>
                  <span className={`${s.ic} ${s.sol}`}>{p.symbol[0].toLowerCase()}</span>
                  <div style={{ minWidth: 0 }}>
                    <div className={s.sym}>{p.symbol}</div>
                    <div className={s.nm}>{p.name}</div>
                  </div>
                  <span className={s.bl}>{p.apy ? `${p.apy}%` : ''}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export { Stake };
