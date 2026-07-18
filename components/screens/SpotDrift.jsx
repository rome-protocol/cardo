'use client';
// SpotDrift screen — act|see redesign. Deposit/withdraw on Drift v2 Spot from
// one EVM wallet. Left: the form. Right: the live signature ledger — fresh = 3
// (Drift stats + user account + deposit), warm = 1 — built from the live init
// probe (useDriftSpotInitState, surfaced via initFlags). Reuses the tested Drift
// init/deposit/withdraw hooks; only the presentation is new.

import React, { useState } from 'react';
import { fmtNum } from '../primitives';
import { Ledger } from '../design/Ledger';
import { TxError, TxHash } from '../design/Inline';
import { signaturePlan } from '../../lib/signature-plan';
import { liveAccountState } from '../../lib/signature-plan-live';
import s from '../design/actsee.module.css';

export function SpotDrift({
  wallet,
  onConnect,
  market,
  ataBalancesByMint = {},
  initFlags = { loading: true, userStatsExists: false, userExists: false },
  initStatsState,
  initUserState,
  depositState,
  withdrawState,
  onInitStats,
  onInitUser,
  onDeposit,
  onWithdraw,
}) {
  const [mode, setMode] = useState('deposit'); // deposit | withdraw
  const [amount, setAmount] = useState('1');
  const a = parseFloat(amount) || 0;
  const sym = market?.symbol ?? 'wSOL';
  const bal = market ? (ataBalancesByMint[market.mintBs58] ?? 0) : 0;

  // Live ledger from the page's Drift init probe (no second probe).
  const st = liveAccountState('lend-drift', {
    driftLoading: initFlags.loading,
    driftStatsExists: initFlags.userStatsExists,
    driftUserExists: initFlags.userExists,
  });
  const steps = signaturePlan('lend-drift', st);
  const plan = {
    steps,
    count: steps.length,
    setupCount: steps.filter((x) => x.setup).length,
    loading: !!wallet.connected && initFlags.loading,
  };

  const needStats = !initFlags.loading && !initFlags.userStatsExists;
  const needUser = !initFlags.loading && initFlags.userStatsExists && !initFlags.userExists;
  const busy = [initStatsState, initUserState, depositState, withdrawState].some(
    (x) => x && !['idle', 'success', 'failed'].includes(x.phase),
  );

  let ctaLabel = mode === 'deposit' ? 'Deposit' : 'Withdraw';
  let ctaCaption = '1 signature · settles atomically on Solana';
  let ctaDisabled = false;
  let ctaOnClick;
  if (!wallet.connected) {
    ctaLabel = 'Connect wallet';
    ctaCaption = 'one wallet — no bridge, no Phantom';
    ctaOnClick = onConnect;
  } else if (initFlags.loading) {
    ctaLabel = 'Checking your Drift account…';
    ctaDisabled = true;
  } else if (needStats) {
    ctaLabel = busy ? 'Creating…' : 'Create Drift stats';
    ctaCaption = '3 signatures · two one-time, then 1';
    ctaDisabled = busy;
    ctaOnClick = onInitStats;
  } else if (needUser) {
    ctaLabel = busy ? 'Creating…' : 'Create Drift account';
    ctaCaption = '2 signatures · one-time, then 1';
    ctaDisabled = busy;
    ctaOnClick = onInitUser;
  } else if (mode === 'deposit') {
    ctaDisabled = busy || a <= 0 || a > bal;
    ctaLabel = busy ? 'Depositing…' : a > bal ? `Insufficient ${sym}` : 'Deposit';
    ctaOnClick = () => onDeposit && onDeposit({ amount: a });
  } else {
    ctaDisabled = busy || a <= 0;
    ctaLabel = busy ? 'Withdrawing…' : 'Withdraw';
    ctaOnClick = () => onWithdraw && onWithdraw({ amount: a });
  }

  // Drift spot deposit/withdraw revert Custom(6087) on devnet (Mollusk
  // owner/slot probe — repo CLAUDE.md agent-tip #6). Gate the write surface to
  // preview-only so a user can't sign a tx that reverts cold, mirroring /perps
  // and /compose. Remove this override when 6087 is resolved.
  if (wallet.connected) {
    ctaDisabled = true;
    ctaOnClick = undefined;
    ctaCaption = 'Drift spot is preview-only on devnet (deposit blocked — Mollusk 6087)';
  }

  const active = depositState ?? withdrawState ?? initUserState ?? initStatsState;
  let statusNode = <>Preview · this is exactly what your wallet will sign</>;
  if (depositState?.phase === 'success' || withdrawState?.phase === 'success') {
    const dn = depositState?.phase === 'success' ? depositState : withdrawState;
    statusNode = (
      <>
        <span className={s.ok}>✓ {depositState?.phase === 'success' ? 'Deposited' : 'Withdrew'} on Drift</span>
        {dn?.hash ? <> · <TxHash hash={dn.hash} /></> : null}
      </>
    );
  } else if (initStatsState?.phase === 'success' && needUser) statusNode = <span className={s.ok}>✓ Stats ready — create account</span>;
  else if (initUserState?.phase === 'success') statusNode = <span className={s.ok}>✓ Account ready — deposit now</span>;
  else if (active?.phase === 'failed') statusNode = <TxError error={active?.error} />;
  else if (busy) statusNode = <>Confirm in MetaMask…</>;

  return (
    <main className={s.work}>
      <div className={s.strip}>
        <div className={s.lead}>
          <span className={s.eyebrow}>Drift · spot lending</span>
          <h1>
            Earn on Solana spot markets — <em>from one wallet</em>.
          </h1>
        </div>
        <span className={s.routepill}>
          <span className={`${s.dot} ${s.evm}`} /> EVM · Rome <span className={s.ar}>→</span> Drift{' '}
          <span className={`${s.dot} ${s.sol}`} />
        </span>
      </div>

      <div className={s.rig}>
        <form className={`${s.col} ${s.act}`} autoComplete="off" onSubmit={(e) => { e.preventDefault(); if (ctaOnClick) ctaOnClick(); }}>
          <div className={s.colhd}>
            <span className={s.sd} /> You do this
          </div>

          <div className={s.tabs}>
            <button type="button" aria-pressed={mode === 'deposit'} onClick={() => setMode('deposit')}>Deposit</button>
            <button type="button" aria-pressed={mode === 'withdraw'} onClick={() => setMode('withdraw')}>Withdraw</button>
          </div>

          <div className={s.leg}>
            <div className={s.r1}>
              <label>You {mode}</label>
              <span className={s.bal}>balance <b>{fmtNum(bal)}</b> {sym}</span>
            </div>
            <div className={s.r2}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <input className={s.amt} inputMode="decimal" aria-label="Amount" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
                <div className={s.usd}>Drift spot · market {market?.marketIndex ?? '—'}</div>
              </div>
              <div className={s.tokchip}>
                <span className={`${s.ic} ${s.sol}`}>{(sym[1] || sym[0] || 's').toLowerCase()}</span>
                <span className={s.sym}>{sym}</span>
              </div>
            </div>
            {mode === 'deposit' && (
              <div className={s.pct}>
                {[25, 50, 100].map((p) => (
                  <button key={p} type="button" onClick={() => setAmount(((bal * p) / 100).toFixed(6).replace(/\.?0+$/, ''))}>
                    {p === 100 ? 'Max' : `${p}%`}
                  </button>
                ))}
              </div>
            )}
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
            <span className={s.pool}>Drift v2 · spot</span>
          </div>
          <div className={s.body}>
            <Ledger
              steps={plan.steps}
              count={plan.count}
              loading={plan.loading}
              sub={<>Drift needs a <b>one-time</b> stats + user account. After that, deposit/withdraw is a single signature.</>}
            />
            <div className={s.outcome}>
              <div className={`${s.ln} ${s.get}`}>
                <span className={s.k}>{mode === 'deposit' ? 'You deposit' : 'You withdraw'}</span>
                <span className={s.v}>{fmtNum(a, 4)} {sym}</span>
              </div>
              <div className={s.ln}>
                <span className={s.k}>Available</span>
                <span className={s.v}>{fmtNum(bal)} {sym}</span>
              </div>
              <div className={s.note}>
                {plan.setupCount > 0 ? (
                  <>Each setup step is its own atomic transaction — Drift&apos;s accounts are <b>signed once, ever</b>.</>
                ) : (
                  <>The transfer and your Drift balance change land <b>together, or neither</b> — one atomic Rome transaction.</>
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
