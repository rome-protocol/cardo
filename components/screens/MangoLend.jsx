'use client';
// MangoLend screen — act|see redesign. Deposit/withdraw on a Mango v4 bank from
// one EVM wallet. Left: the form. Right: the live signature ledger — fresh = 2
// (create Mango account + deposit), warm = 1 — built from the live account probe
// (accountFlags). Reuses the tested Mango create/deposit/withdraw hooks.

import React, { useState } from 'react';
import { fmtNum } from '../primitives';
import { Ledger } from '../design/Ledger';
import { TxError, TxHash } from '../design/Inline';
import s from '../design/actsee.module.css';

export function MangoLend({
  wallet,
  onConnect,
  bank,
  ataBalancesByMint = {},
  /// Amount currently deposited in the Mango bank (human units), or null
  /// while unknown. Drives the Withdraw view; the wallet ATA balance only
  /// drives Deposit.
  depositedAmount = null,
  accountFlags = { loading: true, accountExists: false },
  createState,
  depositState,
  withdrawState,
  onCreate,
  onDeposit,
  onWithdraw,
  tab = 'main',
  onTab,
  panels = {},
}) {
  const [mode, setMode] = useState('deposit'); // deposit | withdraw
  const [amount, setAmount] = useState('1');
  const a = parseFloat(amount) || 0;
  const sym = bank?.symbol ?? 'wSOL';
  const walletBal = bank ? (ataBalancesByMint[bank.mintBs58] ?? 0) : 0;
  // The number the active mode acts on: wallet balance for deposits, the
  // in-Mango deposit for withdrawals.
  const bal = mode === 'deposit' ? walletBal : (depositedAmount ?? 0);
  const balKnown = mode === 'deposit' || depositedAmount !== null;

  const needAccount = !accountFlags.loading && !accountFlags.accountExists;

  // Ledger (hand-built — Mango fresh = create account + action; warm = action).
  const action = {
    id: 'mango-act',
    label: mode === 'deposit' ? 'Deposit to Mango' : 'Withdraw from Mango',
    detail: mode === 'deposit' ? 'token_deposit' : 'token_withdraw',
    atomic: true,
    setup: false,
  };
  const steps = needAccount
    ? [{ id: 'mango-acct', label: 'Create your Mango account', detail: 'account_create', atomic: true, setup: true }, action]
    : [action];
  const plan = {
    steps,
    count: steps.length,
    setupCount: steps.filter((x) => x.setup).length,
    loading: !!wallet.connected && accountFlags.loading,
  };

  const busy = [createState, depositState, withdrawState].some(
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
  } else if (accountFlags.loading) {
    ctaLabel = 'Checking your Mango account…';
    ctaDisabled = true;
  } else if (needAccount) {
    ctaLabel = busy ? 'Creating…' : 'Create Mango account';
    ctaCaption = '2 signatures · one-time, then 1';
    ctaDisabled = busy;
    ctaOnClick = onCreate;
  } else if (mode === 'deposit') {
    ctaDisabled = busy || a <= 0 || a > bal;
    ctaLabel = busy ? 'Depositing…' : a > bal ? `Insufficient ${sym}` : 'Deposit';
    ctaOnClick = () => onDeposit && onDeposit({ amount: a });
  } else {
    ctaDisabled = busy || a <= 0 || (balKnown && a > bal);
    ctaLabel = busy
      ? 'Withdrawing…'
      : balKnown && a > bal
        ? 'More than deposited'
        : 'Withdraw';
    ctaOnClick = () => onWithdraw && onWithdraw({ amount: a });
  }

  let statusNode = <>Preview · this is exactly what your wallet will sign</>;
  // Show the success for the ACTIVE mode's action — not deposit-first. The two
  // hooks are independent state machines and neither resets the other, so after
  // a deposit `depositState` stays `success` forever; keying on `mode` is what
  // makes a later withdraw show its OWN hash + "Withdrew" (was showing the stale
  // "Deposited" + old hash — user-reported 2026-07-11).
  const activeState = mode === 'withdraw' ? withdrawState : depositState;
  if (activeState?.phase === 'success') {
    statusNode = (
      <>
        <span className={s.ok}>✓ {mode === 'withdraw' ? 'Withdrew' : 'Deposited'} on Mango</span>
        {activeState?.hash ? <> · <TxHash hash={activeState.hash} /></> : null}
      </>
    );
  } else if (createState?.phase === 'success' && !needAccount) statusNode = <span className={s.ok}>✓ Account ready — deposit now</span>;
  else if ([createState, depositState, withdrawState].some((x) => x?.phase === 'failed')) statusNode = <TxError error={[createState, depositState, withdrawState].find((x) => x?.phase === 'failed')?.error} />;
  else if (busy) statusNode = <>Confirm in MetaMask…</>;

  return (
    <main className={s.work}>
      <div className={s.strip}>
        <div className={s.lead}>
          <span className={s.eyebrow}>Mango v4 · spot lending</span>
          <h1>
            Lend into Mango markets — <em>from one wallet</em>.
          </h1>
        </div>
        <span className={s.routepill}>
          <span className={`${s.dot} ${s.evm}`} /> EVM · Rome <span className={s.ar}>→</span> Mango{' '}
          <span className={`${s.dot} ${s.sol}`} />
        </span>
      </div>

      {onTab && (
        <div className={s.tabs}>
          <button type="button" aria-pressed={tab === 'main'} onClick={() => onTab('main')}>Deposit · Withdraw</button>
          <button type="button" aria-pressed={tab === 'account'} onClick={() => onTab('account')}>Account</button>
          <button type="button" aria-pressed={tab === 'tcs'} onClick={() => onTab('tcs')}>Conditional swaps</button>
        </div>
      )}

      {tab !== 'main' && panels[tab] ? panels[tab] : (
      <div className={s.rig}>
        <form className={`${s.col} ${s.act}`} autoComplete="off" onSubmit={(e) => { e.preventDefault(); if (ctaOnClick) ctaOnClick(); }}>
          <div className={s.colhd}>
            <span className={s.sd} /> You do this
          </div>

          <div className={s.slip}>
            <button type="button" aria-pressed={mode === 'deposit'} onClick={() => setMode('deposit')}>Deposit</button>
            <button type="button" aria-pressed={mode === 'withdraw'} onClick={() => setMode('withdraw')}>Withdraw</button>
          </div>

          <div className={s.leg}>
            <div className={s.r1}>
              <label>You {mode}</label>
              <span className={s.bal}>
                {mode === 'deposit' ? 'balance' : 'deposited'}{' '}
                <b>{balKnown ? fmtNum(bal) : '—'}</b> {sym}
              </span>
            </div>
            <div className={s.r2}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <input className={s.amt} inputMode="decimal" aria-label="Amount" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
                <div className={s.usd}>Mango bank · {bank?.symbol ?? ''}</div>
              </div>
              <div className={s.tokchip}>
                <span className={`${s.ic} ${s.sol}`}>{(sym[1] || sym[0] || 's').toLowerCase()}</span>
                <span className={s.sym}>{sym}</span>
              </div>
            </div>
            {(mode === 'deposit' || balKnown) && (
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
            <span className={s.pool}>Mango v4 · spot</span>
          </div>
          <div className={s.body}>
            <Ledger
              steps={plan.steps}
              count={plan.count}
              loading={plan.loading}
              sub={<>Mango needs a <b>one-time</b> account. After that, deposit/withdraw is a single signature.</>}
            />
            <div className={s.outcome}>
              <div className={`${s.ln} ${s.get}`}>
                <span className={s.k}>{mode === 'deposit' ? 'You deposit' : 'You withdraw'}</span>
                <span className={s.v}>{fmtNum(a, 4)} {sym}</span>
              </div>
              <div className={s.ln}>
                <span className={s.k}>{mode === 'deposit' ? 'In your wallet' : 'Deposited in Mango'}</span>
                <span className={s.v}>{balKnown ? fmtNum(bal) : '—'} {sym}</span>
              </div>
              <div className={s.note}>
                {plan.setupCount > 0 ? (
                  <>Your Mango account is created once, then reused — <b>signed once, ever</b>.</>
                ) : (
                  <>The transfer and your Mango balance change land <b>together, or neither</b> — one atomic Rome transaction.</>
                )}
              </div>
            </div>
          </div>
          <div className={s.status}>{statusNode}</div>
        </section>
      </div>
      )}
    </main>
  );
}
