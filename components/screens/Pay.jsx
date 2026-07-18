'use client';
// Pay screen — act|see redesign. Open a Streamflow token stream to any Solana
// wallet. Genuinely ONE signature: Streamflow's create_v2 inits the recipient's
// token account inline (init_if_needed) signed by your Rome PDA — no ephemeral
// keypair, no recipient setup. Left: the stream form. Right: the 1-step ledger.
//
// Working parts (token list, balances, create) lifted from app/pay/page.tsx.

import React, { useState, useEffect, useMemo } from 'react';
import { fmtNum } from '../primitives';
import { Ledger } from '../design/Ledger';
import { TxError, TxHash, Address } from '../design/Inline';
import { signaturePlan } from '../../lib/signature-plan';
import s from '../design/actsee.module.css';

const DURATIONS = [
  { label: '1 day', seconds: 86_400 },
  { label: '1 week', seconds: 604_800 },
  { label: '1 month', seconds: 2_592_000 },
  { label: '3 months', seconds: 7_776_000 },
];

function iconClass(sym) {
  const u = (sym || '').toUpperCase();
  if (u.includes('USD')) return s.usdc;
  if (u.includes('SOL')) return s.sol;
  if (u.includes('ETH')) return s.eth;
  return s.gen;
}

const Pay = ({
  wallet,
  onConnect,
  tokens = [],
  ataBalancesByMint = {},
  /// (input: string) => ResolvedRecipient — chain-aware resolver from the
  /// page (lib/recipient-resolve bound to the active chain). Accepts a
  /// Solana bs58 pubkey or an EVM 0x address (another cardo user).
  resolveRecipient,
  onCreate,
  createState,
  tab = 'create',
  onTab,
  children,
}) => {
  const [tokenSym, setTokenSym] = useState(tokens[0]?.symbol ?? 'wUSDC');
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [durIdx, setDurIdx] = useState(1);
  const [cancelable, setCancelable] = useState(true);
  const [showPicker, setShowPicker] = useState(false);

  useEffect(() => {
    if (tokens.length && !tokens.find((t) => t.symbol === tokenSym)) setTokenSym(tokens[0].symbol);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokens.map((t) => t.symbol).join(',')]);

  const token = tokens.find((t) => t.symbol === tokenSym) ?? tokens[0];
  const mintBs58 = token?.mintAddress;
  const a = parseFloat(amount) || 0;
  const balance = mintBs58 ? (ataBalancesByMint[mintBs58] ?? 0) : 0;

  // Streamflow is genuinely one signature regardless of recipient state.
  const steps = signaturePlan('pay-streamflow', {});
  const plan = { steps, count: steps.length, loading: false };

  // Resolve as the user types: Solana pubkey or EVM 0x → Rome PDA. The old
  // gate was length>=32 only, which let 0x… addresses through to a swallowed
  // throw — "Start stream" silently did nothing.
  const resolution = useMemo(
    () => (resolveRecipient ? resolveRecipient(recipient) : null),
    [resolveRecipient, recipient],
  );
  const recipientOk = resolution
    ? resolution.kind !== 'invalid'
    : recipient.trim().length >= 32;
  const recipientEntered = recipient.trim().length > 0;
  const busy = createState && !['idle', 'success', 'failed'].includes(createState.phase);

  let ctaLabel = 'Start stream';
  let ctaCaption = '1 signature · recipient needs nothing here';
  let ctaDisabled = false;
  let ctaOnClick;
  if (!wallet.connected) {
    ctaLabel = 'Connect wallet';
    ctaCaption = 'one wallet — no bridge, no Phantom';
    ctaOnClick = onConnect;
  } else {
    ctaDisabled = busy || !recipientOk || a <= 0 || a > balance;
    ctaLabel = busy
      ? 'Opening stream…'
      : a > balance
        ? `Insufficient ${tokenSym}`
        : !recipientOk
          ? recipientEntered
            ? 'Check recipient address'
            : 'Enter recipient'
          : 'Start stream';
    ctaOnClick = () =>
      onCreate &&
      onCreate({
        recipient: recipient.trim(),
        mintBs58,
        decimals: token?.decimals ?? 6,
        amountHuman: a,
        durationSeconds: DURATIONS[durIdx].seconds,
        name: `Stream to ${recipient.trim().slice(0, 4)}…`,
        cancelable,
      });
  }

  let statusNode = <>Preview · this is exactly what your wallet will sign</>;
  if (createState?.phase === 'success') statusNode = <><span className={s.ok}>✓ Stream opened</span>{createState?.hash ? <> · <TxHash hash={createState.hash} /></> : null}</>;
  else if (createState?.phase === 'failed') statusNode = <TxError error={createState.error} />;
  else if (busy) statusNode = <>Confirm in MetaMask…</>;

  return (
    <>
      <main className={s.work}>
        <div className={s.strip}>
          <div className={s.lead}>
            <span className={s.eyebrow}>Streamflow · token streaming</span>
            <h1>
              Stream to any Solana wallet — <em>one signature</em>.
            </h1>
          </div>
          <span className={s.routepill}>
            <span className={`${s.dot} ${s.evm}`} /> EVM · Rome <span className={s.ar}>→</span> Streamflow{' '}
            <span className={`${s.dot} ${s.sol}`} />
          </span>
        </div>

        {onTab && (
          <div className={s.tabs}>
            <button type="button" aria-pressed={tab === 'create'} onClick={() => onTab('create')}>
              Create stream
            </button>
            <button type="button" aria-pressed={tab === 'manage'} onClick={() => onTab('manage')}>
              Manage
            </button>
          </div>
        )}

        {tab === 'manage' && children ? (
          children
        ) : (
        <div className={s.rig}>
          <form className={`${s.col} ${s.act}`} autoComplete="off" onSubmit={(e) => { e.preventDefault(); if (ctaOnClick) ctaOnClick(); }}>
            <div className={s.colhd}>
              <span className={s.sd} /> You do this
            </div>

            <div className={s.field}>
              <label htmlFor="pay-recip">Recipient · Solana or EVM address</label>
              <input
                id="pay-recip"
                className={s.txt}
                placeholder="Solana address, or 0x… (another Rome user)"
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
              />
              {resolution?.kind === 'evm' && (
                <div className={s.usd} style={{ marginTop: 6 }}>
                  EVM address — streams to their Rome account{' '}
                  <Address value={resolution.recipientBs58} />
                </div>
              )}
              {recipientEntered && resolution?.kind === 'invalid' && (
                <div className={s.usd} style={{ marginTop: 6 }}>
                  {resolution.reason}
                </div>
              )}
            </div>

            <div className={s.leg}>
              <div className={s.r1}>
                <label>You stream</label>
                <span className={s.bal}>
                  balance <b>{fmtNum(balance)}</b> {tokenSym}
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
                  <div className={s.usd}>total over the stream period</div>
                </div>
                <button type="button" className={s.tokchip} onClick={() => tokens.length > 1 && setShowPicker(true)}>
                  <span className={`${s.ic} ${iconClass(tokenSym)}`}>{tokenSym.charAt(0).toLowerCase()}</span>
                  <span className={s.sym}>{tokenSym}</span>
                  {tokens.length > 1 && <span className={s.car}>▾</span>}
                </button>
              </div>
              <div className={s.pct}>
                {[25, 50, 100].map((p) => (
                  <button key={p} type="button" onClick={() => setAmount(((balance * p) / 100).toFixed(6).replace(/\.?0+$/, ''))}>
                    {p === 100 ? 'Max' : `${p}%`}
                  </button>
                ))}
              </div>
            </div>

            <div className={s.slip}>
              <span className={s.lbl}>Over</span>
              {DURATIONS.map((d, i) => (
                <button key={d.label} type="button" aria-pressed={durIdx === i} onClick={() => setDurIdx(i)}>
                  {d.label}
                </button>
              ))}
            </div>

            <div className={s.slip}>
              <span className={s.lbl}>Cancelable</span>
              <button type="button" aria-pressed={cancelable} onClick={() => setCancelable(true)}>
                Yes
              </button>
              <button type="button" aria-pressed={!cancelable} onClick={() => setCancelable(false)}>
                No
              </button>
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
              <span className={s.pool}>Streamflow · create_v2</span>
            </div>
            <div className={s.body}>
              <Ledger
                steps={plan.steps}
                count={plan.count}
                sub={
                  <>
                    The recipient is a <b>native Solana wallet</b> — no Rome account, no bridge,
                    nothing to set up on their end.
                  </>
                }
              />
              <div className={s.outcome}>
                <div className={`${s.ln} ${s.get}`}>
                  <span className={s.k}>You stream</span>
                  <span className={s.v}>
                    {fmtNum(a, 4)} {tokenSym}
                  </span>
                </div>
                <div className={s.ln}>
                  <span className={s.k}>Over</span>
                  <span className={s.v}>{DURATIONS[durIdx].label}</span>
                </div>
                <div className={s.ln}>
                  <span className={s.k}>Cancelable</span>
                  <span className={s.v}>{cancelable ? 'yes' : 'no'}</span>
                </div>
                <div className={s.note}>
                  Streamflow creates the recipient&apos;s token account inline, signed by your Rome
                  account — so opening a stream is <b>genuinely one signature</b>, even to a wallet
                  that has never held this token.
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
            <span className={s.eyebrow}>Select token</span>
            <div className={s.list} style={{ marginTop: 14 }}>
              {tokens.map((t) => (
                <button key={t.symbol} type="button" className={s.row} disabled={t.symbol === tokenSym} onClick={() => { setTokenSym(t.symbol); setShowPicker(false); }}>
                  <span className={`${s.ic} ${iconClass(t.symbol)}`}>{t.symbol.charAt(0).toLowerCase()}</span>
                  <div style={{ minWidth: 0 }}>
                    <div className={s.sym}>{t.symbol}</div>
                    <div className={s.nm}>{ataBalancesByMint[t.mintAddress] != null ? `${fmtNum(ataBalancesByMint[t.mintAddress])} held` : ''}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export { Pay };
