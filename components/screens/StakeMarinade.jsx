'use client';
// StakeMarinade screen — act|see redesign. Stake native SOL into Marinade
// liquid staking (→ mSOL) from one EVM wallet. Left: the stake form. Right: the
// live signature ledger (fresh 2 = create mSOL account + stake; warm 1). Reuses
// the tested Marinade deposit + ATA-init hooks; only the presentation is new.

import React, { useState } from 'react';
import { fmtNum } from '../primitives';
import { Ledger } from '../design/Ledger';
import { Address, TxError, TxHash } from '../design/Inline';
import { signaturePlan } from '../../lib/signature-plan';
import { statusToFlag } from '../../lib/signature-plan-live';
import { lamportsToSol, compactNum, safeRatio } from '../../lib/stats-format';
import { bytes32ToPublicKey } from '../../lib/solana-pda';
import { romeStaticTokens } from '../../lib/addresses';
import s from '../design/actsee.module.css';

export function StakeMarinade({
  wallet,
  onConnect,
  view,
  solBalance = 0,
  msolBalance = 0,
  msolMintHex,
  ataStatusByMint = {},
  ataInitState,
  onSetup,
  onDeposit,
  depositState,
}) {
  const [amount, setAmount] = useState('1');
  const a = parseFloat(amount) || 0;
  const stateLoading = !view?.state;
  const ataStatus = msolMintHex ? ataStatusByMint[msolMintHex] : undefined;

  // Live Marinade stats (already computed by useMarinadeState — just render them).
  const msolPerSol = view?.msolPerSol ?? null;            // mSOL minted per 1 SOL
  const solPerMsol = safeRatio(1, msolPerSol);            // 1 mSOL is worth this many SOL (>1, appreciates)
  const estMsolOut = msolPerSol != null ? a * msolPerSol : a;
  const tvlSol = lamportsToSol(view?.totalLamportsUnderControl);

  const rawSteps = signaturePlan('stake', { outAtaExists: statusToFlag(ataStatus) });
  const steps = rawSteps.map((st) =>
    st.id === 'stake' ? { ...st, label: 'Stake with Marinade', detail: 'deposit → mSOL' } : st,
  );
  const plan = {
    steps,
    count: steps.length,
    loading: wallet.connected && !!msolMintHex && (ataStatus === undefined || ataStatus === 'unknown'),
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
  } else if (stateLoading) {
    ctaLabel = 'Loading Marinade…';
    ctaDisabled = true;
  } else if (ataMissing) {
    ctaLabel = busy ? 'Creating account…' : 'Create mSOL account';
    ctaCaption = '1 signature · one-time, then stake in 1';
    ctaDisabled = busy;
    ctaOnClick = onSetup;
  } else {
    ctaDisabled = busy || a <= 0 || a > solBalance;
    ctaLabel = busy ? 'Staking…' : a > solBalance ? 'Insufficient SOL' : 'Stake';
    ctaOnClick = () => onDeposit && onDeposit({ amountSol: a });
  }

  const status = depositState?.phase ?? ataInitState?.phase;

  // Identity of the token this flow mints — surfaced on success so the
  // user sees exactly what they received (SPL mint + Rome wrapper), not
  // just the CPI call. Wrapper resolved by backing mint from the static
  // token surface.
  const msolMintB58 = msolMintHex ? bytes32ToPublicKey(msolMintHex).toBase58() : null;
  const msolWrapper = msolMintB58
    ? romeStaticTokens().find((t) => t.mintAddress === msolMintB58)?.address
    : undefined;

  let statusNode = <>Preview · this is exactly what your wallet will sign</>;
  if (depositState?.phase === 'success')
    statusNode = (
      <>
        <span className={s.ok}>✓ Staked · mSOL in your account</span>
        {depositState?.hash ? <> · <TxHash hash={depositState.hash} /></> : null}
        {msolMintB58 ? (
          <>
            {' '}· mint <Address value={msolMintB58} title="mSOL SPL mint" />
            {msolWrapper ? (
              <> · wrapper <Address value={msolWrapper} title="mSOL ERC20 wrapper on Rome" /></>
            ) : null}
            {' '}· swap it on <a href="/swap">/swap</a>
          </>
        ) : null}
      </>
    );
  else if (ataInitState?.phase === 'success' && !ataMissing)
    statusNode = <span className={s.ok}>✓ Account ready — stake now</span>;
  else if (status === 'failed') statusNode = <TxError error={depositState?.error ?? ataInitState?.error} />;
  else if (busy) statusNode = <>Confirm in MetaMask…</>;

  return (
    <main className={s.work}>
      <div className={s.strip}>
        <div className={s.lead}>
          <span className={s.eyebrow}>Marinade · liquid staking</span>
          <h1>
            Stake SOL into mSOL — <em>stay liquid</em>.
          </h1>
        </div>
        <span className={s.routepill}>
          <span className={`${s.dot} ${s.evm}`} /> EVM · Rome <span className={s.ar}>→</span> Marinade{' '}
          <span className={`${s.dot} ${s.sol}`} />
        </span>
      </div>

      <div className={s.rig}>
        <form className={`${s.col} ${s.act}`} autoComplete="off" onSubmit={(e) => { e.preventDefault(); if (ctaOnClick) ctaOnClick(); }}>
          <div className={s.colhd}>
            <span className={s.sd} /> You do this
          </div>

          <div className={s.leg}>
            <div className={s.r1}>
              <label>You stake</label>
              <span className={s.bal}>balance <b>{fmtNum(solBalance)}</b> SOL</span>
            </div>
            <div className={s.r2}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <input className={s.amt} inputMode="decimal" aria-label="Stake amount" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
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
              <span className={s.bal}>balance <b>{fmtNum(msolBalance)}</b> mSOL</span>
            </div>
            <div className={s.r2}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className={`${s.amt} ${s.out}`}>{a > 0 ? `≈ ${fmtNum(estMsolOut, 4)}` : '0.00'}</div>
                <div className={s.usd}>
                  {solPerMsol != null ? `1 mSOL = ${fmtNum(solPerMsol, 4)} SOL` : 'rate read live at submit'}
                </div>
              </div>
              <div className={s.tokchip}>
                <span className={`${s.ic} ${s.sol}`}>m</span>
                <span className={s.sym}>mSOL</span>
              </div>
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
            <span className={s.pool}>Marinade · mSOL</span>
          </div>
          <div className={s.body}>
            <Ledger
              steps={plan.steps}
              count={plan.count}
              loading={plan.loading}
              sub={<>You get <b>mSOL</b> — a liquid stake token you can swap or lend anytime, no unbonding wait.</>}
            />
            <div className={s.outcome}>
              <div className={`${s.ln} ${s.get}`}>
                <span className={s.k}>You receive</span>
                <span className={s.v}>~{fmtNum(estMsolOut, 4)} mSOL</span>
              </div>
              <div className={s.ln}>
                <span className={s.k}>Exchange rate</span>
                <span className={s.v}>{solPerMsol != null ? `1 mSOL = ${fmtNum(solPerMsol, 4)} SOL` : '—'}</span>
              </div>
              <div className={s.ln}>
                <span className={s.k}>Marinade TVL <small>staked</small></span>
                <span className={s.v}>{tvlSol > 0 ? `◎ ${compactNum(tvlSol)}` : '—'}</span>
              </div>
              {msolBalance > 0 && (
                <div className={s.ln}>
                  <span className={s.k}>Your mSOL <small>≈ SOL</small></span>
                  <span className={s.v}>{fmtNum(msolBalance, 4)} <small>≈ ◎ {fmtNum(msolBalance * (solPerMsol ?? 1), 4)}</small></span>
                </div>
              )}
              <div className={s.note}>
                First stake creates your mSOL account (<b>one</b> extra signature); after that, staking is a
                single signature. The mSOL is yours immediately.
              </div>
            </div>
          </div>
          <div className={s.status}>{statusNode}</div>
        </section>
      </div>
    </main>
  );
}
