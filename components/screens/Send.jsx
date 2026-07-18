'use client';
// Send screen — act|see redesign. Transfer a wrapped SPL from your Rome PDA to
// any Solana wallet (transfer_spl). Left: the send form. Right: the live ledger
// — fresh = 2 (create the recipient's token account + send), warm = 1 — built
// from the recipient-ATA pre-flight the page already polls (recipientAtaStatus).
//
// Working parts (token list, balances, recipient pre-flight, send) lifted from
// app/send/page.tsx. Advanced token ops (approve/revoke/burn/close/sync) are
// deferred from this iteration — their handlers remain wired in the page.

import React, { useState, useEffect, useMemo } from 'react';
import { fmtNum } from '../primitives';
import { Ledger } from '../design/Ledger';
import { TxError, TxHash, Address } from '../design/Inline';
import { signaturePlan } from '../../lib/signature-plan';
import { statusToFlag } from '../../lib/signature-plan-live';
import s from '../design/actsee.module.css';

function iconClass(sym) {
  const u = (sym || '').toUpperCase();
  if (u.includes('USD')) return s.usdc;
  if (u.includes('SOL')) return s.sol;
  if (u.includes('ETH')) return s.eth;
  return s.gen;
}

const phaseBusy = (p) => p === 'signing' || p === 'confirming';
const btnTxt = (p, idle, done, fail) =>
  p === 'signing'
    ? 'Awaiting signature…'
    : p === 'confirming'
      ? 'Confirming on Solana…'
      : p === 'success'
        ? done
        : p === 'failed'
          ? fail
          : idle;

const Send = ({
  wallet,
  onConnect,
  tokens = [],
  ataBalancesByMint = {},
  /// (input: string) => ResolvedRecipient — chain-aware resolver from the
  /// page. Accepts a Solana bs58 pubkey or an EVM 0x address (another
  /// cardo user → their Rome PDA).
  resolveRecipient,
  recipientAtaStatus = 'unknown',
  onRecipientChange,
  onTokenChange,
  onSend,
  sendState,
  tab = 'main',
  onTab,
  onApprove,
  approveState,
  onRevoke,
  revokeState,
  onBurn,
  burnState,
  onClose,
  closeState,
  onSyncNative,
  syncState,
}) => {
  const [tokenSym, setTokenSym] = useState(tokens[0]?.symbol ?? 'wUSDC');
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [showPicker, setShowPicker] = useState(false);
  const [delegate, setDelegate] = useState('');
  const [approveAmount, setApproveAmount] = useState('');
  const [burnAmount, setBurnAmount] = useState('');

  useEffect(() => {
    if (typeof onRecipientChange === 'function') onRecipientChange(recipient);
  }, [recipient, onRecipientChange]);
  useEffect(() => {
    if (typeof onTokenChange === 'function') onTokenChange(tokenSym);
  }, [tokenSym, onTokenChange]);
  useEffect(() => {
    if (tokens.length && !tokens.find((t) => t.symbol === tokenSym)) setTokenSym(tokens[0].symbol);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokens.map((t) => t.symbol).join(',')]);

  const token = tokens.find((t) => t.symbol === tokenSym) ?? tokens[0];
  const mintBs58 = token?.mintAddress;
  const decimals = token?.decimals ?? 6;
  const balance = mintBs58 ? (ataBalancesByMint[mintBs58] ?? 0) : 0;
  const a = parseFloat(amount) || 0;

  const resolution = useMemo(
    () => (resolveRecipient ? resolveRecipient(recipient) : null),
    [resolveRecipient, recipient],
  );
  const recipientValid = useMemo(() => {
    if (resolution) return resolution.kind !== 'invalid';
    if (!recipient) return false;
    if (recipient.length < 32 || recipient.length > 44) return false;
    return /^[1-9A-HJ-NP-Za-km-z]+$/.test(recipient);
  }, [resolution, recipient]);
  const recipientEntered = recipient.trim().length > 0;

  // Live ledger from the page's recipient-ATA pre-flight (no second probe).
  const steps = signaturePlan('send', {
    recipientAtaExists: recipientValid ? statusToFlag(recipientAtaStatus) : undefined,
  });
  const plan = {
    steps,
    count: steps.length,
    loading: recipientValid && (recipientAtaStatus === 'unknown' || recipientAtaStatus === undefined),
  };

  const busy = sendState && !['idle', 'success', 'failed'].includes(sendState.phase);

  let ctaLabel = 'Send';
  let ctaCaption = recipientAtaStatus === 'missing' ? '2 signatures · first send to this wallet' : '1 signature · settles atomically on Solana';
  let ctaDisabled = false;
  let ctaOnClick;
  if (!wallet.connected) {
    ctaLabel = 'Connect wallet';
    ctaCaption = 'one wallet — no bridge, no Phantom';
    ctaOnClick = onConnect;
  } else {
    ctaDisabled = busy || !recipientValid || a <= 0 || a > balance;
    ctaLabel = busy
      ? 'Sending…'
      : a > balance
        ? `Insufficient ${tokenSym}`
        : !recipientValid
          ? recipientEntered
            ? 'Check recipient address'
            : 'Enter recipient'
          : 'Send';
    ctaOnClick = () =>
      onSend &&
      onSend({ recipient: recipient.trim(), mintBs58, amountHuman: a, decimals, symbol: tokenSym });
  }

  let statusNode = <>Preview · this is exactly what your wallet will sign</>;
  if (sendState?.phase === 'success') statusNode = <><span className={s.ok}>✓ Sent</span>{sendState?.hash ? <> · <TxHash hash={sendState.hash} /></> : null}</>;
  else if (sendState?.phase === 'failed') statusNode = <TxError error={sendState.error} />;
  else if (busy) statusNode = <>Confirm in MetaMask…</>;

  const connected = !!wallet.connected;
  const actionsRig = (
    <div className={s.rig}>
      <div className={`${s.col} ${s.act}`}>
        <div className={s.colhd}><span className={s.sd} /> Token actions</div>
        <div className={s.field}>
          <label>Token</label>
          <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 10 }}>
            <button type="button" className={s.tokchip} onClick={() => tokens.length > 1 && setShowPicker(true)}>
              <span className={`${s.ic} ${iconClass(tokenSym)}`}>{tokenSym.charAt(0).toLowerCase()}</span>
              <span className={s.sym}>{tokenSym}</span>
              {tokens.length > 1 && <span className={s.car}>▾</span>}
            </button>
            <span className={s.bal}>balance <b>{fmtNum(balance)}</b></span>
          </div>
        </div>
        <div className={s.field}>
          <label>Approve a delegate</label>
          <input className={s.txt} value={delegate} onChange={(e) => setDelegate(e.target.value.trim())} placeholder="Delegate pubkey (bs58)" />
          <input className={s.txt} value={approveAmount} onChange={(e) => setApproveAmount(e.target.value)} placeholder={`Amount of ${tokenSym}`} />
          <button type="button" className={s.btn2} style={{ marginTop: 10 }} disabled={!connected || !delegate || !(parseFloat(approveAmount) > 0) || phaseBusy(approveState?.phase)} onClick={() => onApprove && onApprove({ token, delegate, amount: parseFloat(approveAmount) || 0 })}>
            {btnTxt(approveState?.phase, 'Approve delegate', 'Approved ✓', 'Approve failed — try again')}
          </button>
          {approveState?.phase === 'failed' && approveState?.error && <div className={s.note} style={{ marginTop: 8 }}><TxError error={approveState.error} /></div>}
        </div>
        <div className={s.field}>
          <label>Revoke delegate</label>
          <button type="button" className={s.btn2} style={{ marginTop: 8 }} disabled={!connected || phaseBusy(revokeState?.phase)} onClick={() => onRevoke && onRevoke({ token })}>
            {btnTxt(revokeState?.phase, 'Revoke delegate', 'Revoked ✓', 'Revoke failed — try again')}
          </button>
          {revokeState?.phase === 'failed' && revokeState?.error && <div className={s.note} style={{ marginTop: 8 }}><TxError error={revokeState.error} /></div>}
        </div>
        <div className={s.field}>
          <label>Burn {tokenSym}</label>
          <input className={s.txt} value={burnAmount} onChange={(e) => setBurnAmount(e.target.value)} placeholder="Amount to burn" />
          <button type="button" className={s.btn2} style={{ marginTop: 10 }} disabled={!connected || !(parseFloat(burnAmount) > 0) || phaseBusy(burnState?.phase)} onClick={() => onBurn && onBurn({ token, amount: parseFloat(burnAmount) || 0 })}>
            {btnTxt(burnState?.phase, 'Burn tokens', 'Burned ✓', 'Burn failed — try again')}
          </button>
          {burnState?.phase === 'failed' && burnState?.error && <div className={s.note} style={{ marginTop: 8 }}><TxError error={burnState.error} /></div>}
        </div>
        <div className={s.field}>
          <label>Close token account</label>
          <button type="button" className={s.btn2} style={{ marginTop: 8 }} disabled={!connected || phaseBusy(closeState?.phase)} onClick={() => onClose && onClose({ token })}>
            {btnTxt(closeState?.phase, 'Close account — reclaim rent', 'Closed ✓', 'Close failed — try again')}
          </button>
          {closeState?.phase === 'failed' && closeState?.error && <div className={s.note} style={{ marginTop: 8 }}><TxError error={closeState.error} /></div>}
        </div>
        <div className={s.field}>
          <label>Sync native (wSOL)</label>
          <button type="button" className={s.btn2} style={{ marginTop: 8 }} disabled={!connected || phaseBusy(syncState?.phase)} onClick={() => onSyncNative && onSyncNative()}>
            {btnTxt(syncState?.phase, 'Sync wSOL balance', 'Synced ✓', 'Sync failed — try again')}
          </button>
          {syncState?.phase === 'failed' && syncState?.error && <div className={s.note} style={{ marginTop: 8 }}><TxError error={syncState.error} /></div>}
        </div>
      </div>
      <section className={`${s.col} ${s.see}`}>
        <div className={s.colhd}><span className={s.sd} /> What will happen <span className={s.pool}>SPL Token · actions</span></div>
        <div className={s.body}>
          <div className={s.outcome}>
            <div className={s.note}>
              <b>Approve</b> lets a delegate spend your {tokenSym}; <b>Revoke</b> clears it. <b>Burn</b> permanently
              destroys tokens. <b>Close</b> reclaims the token account&apos;s rent (it must be empty first).
              <b> Sync native</b> refreshes wSOL&apos;s wrapped balance. Each is a single signature.
            </div>
            {!connected && <div className={s.note} style={{ marginTop: 10 }}>Connect your wallet (Send tab) to enable these actions.</div>}
          </div>
        </div>
      </section>
    </div>
  );

  return (
    <>
      <main className={s.work}>
        <div className={s.strip}>
          <div className={s.lead}>
            <span className={s.eyebrow}>SPL transfer · Solana</span>
            <h1>
              Send wrapped tokens to any Solana wallet — <em>from MetaMask</em>.
            </h1>
          </div>
          <span className={s.routepill}>
            <span className={`${s.dot} ${s.evm}`} /> EVM · Rome <span className={s.ar}>→</span> SPL transfer{' '}
            <span className={`${s.dot} ${s.sol}`} />
          </span>
        </div>

        {onTab && (
          <div className={s.tabs}>
            <button type="button" aria-pressed={tab === 'main'} onClick={() => onTab('main')}>Send</button>
            <button type="button" aria-pressed={tab === 'actions'} onClick={() => onTab('actions')}>Token actions</button>
          </div>
        )}

        {tab === 'actions' && actionsRig ? actionsRig : (
        <div className={s.rig}>
          <form className={`${s.col} ${s.act}`} autoComplete="off" onSubmit={(e) => { e.preventDefault(); if (ctaOnClick) ctaOnClick(); }}>
            <div className={s.colhd}>
              <span className={s.sd} /> You do this
            </div>

            <div className={s.field}>
              <label htmlFor="send-recip">Recipient · Solana or EVM address</label>
              <input
                id="send-recip"
                className={s.txt}
                placeholder="Solana address, or 0x… (another Rome user)"
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
              />
              {resolution?.kind === 'evm' && (
                <div className={s.usd} style={{ marginTop: 6 }}>
                  EVM address — sends to their Rome account{' '}
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
                <label>You send</label>
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
                  <div className={s.usd}>real SPL on Solana</div>
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
              <span className={s.pool}>SPL Token · transfer</span>
            </div>
            <div className={s.body}>
              <Ledger
                steps={plan.steps}
                count={plan.count}
                loading={plan.loading}
                sub={
                  <>
                    Send any wrapped SPL to a Solana wallet straight from MetaMask — <b>one wallet,
                    no bridge</b>.
                  </>
                }
              />
              <div className={s.outcome}>
                <div className={`${s.ln} ${s.get}`}>
                  <span className={s.k}>They receive</span>
                  <span className={s.v}>
                    {fmtNum(a, 6)} {tokenSym}
                  </span>
                </div>
                <div className={s.ln}>
                  <span className={s.k}>Recipient account</span>
                  <span className={s.v}>
                    {!recipientValid ? '—' : recipientAtaStatus === 'missing' ? 'will be created' : recipientAtaStatus === 'exists' ? 'ready' : 'checking…'}
                  </span>
                </div>
                <div className={s.note}>
                  If the recipient has never held this token, the first send adds <b>one</b>
                  account-creation signature; after that it&apos;s a single signature.
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

export { Send };
