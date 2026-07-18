'use client';
// Vote screen — act|see redesign. SPL Governance v3 (Realms) `cast_vote` from one
// EVM wallet. Left: pick Yes/No + see the proposal. Right: the live signature
// ledger (1 sig · cast_vote) + the honest gate (you need a TokenOwnerRecord on
// the realm first — Rome can't mint that for you). Same gate logic + hooks as
// before; only the presentation moved from the retired light design to the rig.

import React, { useState } from 'react';
import { Ledger } from '../design/Ledger';
import { TxError, TxHash, Address } from '../design/Inline';
import s from '../design/actsee.module.css';

const REALMS_APP_URL = 'https://app.realms.today/';

const Vote = ({ wallet, onConnect, proposal, proposalState, onCast, voteState }) => {
  const [choice, setChoice] = useState('yes'); // yes | no
  const phase = voteState?.phase ?? 'idle';
  const isWorking = phase === 'signing' || phase === 'confirming';

  const now = Math.floor(Date.now() / 1000);
  const timeRemainingSec =
    proposalState?.voteEndsAt != null ? Math.max(0, proposalState.voteEndsAt - now) : null;
  const remainingHuman =
    timeRemainingSec == null
      ? null
      : timeRemainingSec >= 86400
        ? `${Math.floor(timeRemainingSec / 86400)}d ${Math.floor((timeRemainingSec % 86400) / 3600)}h`
        : timeRemainingSec >= 3600
          ? `${Math.floor(timeRemainingSec / 3600)}h ${Math.floor((timeRemainingSec % 3600) / 60)}m`
          : `${Math.floor(timeRemainingSec / 60)}m`;

  // Submission gate — most actionable error first. Unchanged from the prior
  // screen; this is the honest "you can't vote yet, and here's why" logic.
  const gateMessage = !wallet?.connected
    ? null
    : !proposal
      ? 'No proposal pinned in registry.'
      : proposalState?.loading
        ? null
        : proposalState?.error
          ? `RPC error: ${proposalState.error}`
          : !proposalState?.proposalExists
            ? 'Pinned proposal account not found on devnet.'
            : !proposalState?.isOpen
              ? 'Voting window has closed for this proposal.'
              : !proposalState?.callerHasTor
                ? `You don't have a TokenOwnerRecord for the ${proposal.governingTokenLabel} mint of "${proposal.realmName}". Deposit governing tokens in the Realms web app first, then come back to vote.`
                : proposalState?.callerHasVoted
                  ? 'You already cast a vote on this proposal — a VoteRecord exists.'
                  : null;

  const needsRealmsLink = !proposalState?.callerHasTor && proposalState?.proposalExists;

  const submitDisabled =
    !wallet?.connected ||
    !proposal ||
    proposalState?.loading ||
    !proposalState?.proposalExists ||
    !proposalState?.isOpen ||
    !proposalState?.callerHasTor ||
    proposalState?.callerHasVoted ||
    isWorking;

  const choiceWord = choice === 'yes' ? 'Approve' : 'Deny';

  let ctaLabel =
    choice === 'yes'
      ? `Vote Yes${proposal?.singleChoiceLabel ? ` — ${proposal.singleChoiceLabel}` : ''}`
      : 'Vote No';
  let ctaCaption = '1 signature · cast_vote on SPL Governance';
  let ctaDisabled = submitDisabled;
  let ctaOnClick = () => onCast?.({ kind: choice });
  if (!wallet?.connected) {
    ctaLabel = 'Connect wallet';
    ctaCaption = 'one wallet — no bridge, no Phantom';
    ctaDisabled = false;
    ctaOnClick = onConnect;
  } else if (isWorking) {
    ctaLabel = phase === 'signing' ? 'Awaiting signature…' : 'Confirming…';
    ctaCaption = '1 signature · cast_vote on SPL Governance';
    ctaDisabled = true;
  } else if (phase === 'success') {
    ctaLabel = `Voted ${voteState?.vote === 'no' ? 'No' : 'Yes'} ✓`;
    ctaDisabled = true;
  }

  let statusNode = <>Preview · this is exactly what your wallet will sign</>;
  if (phase === 'success')
    statusNode = (
      <>
        <span className={s.ok}>✓ Vote cast on SPL Governance</span>
        {voteState?.hash ? <> · <TxHash hash={voteState.hash} /></> : null}
      </>
    );
  else if (phase === 'failed') statusNode = <TxError error={voteState?.error} />;
  else if (isWorking) statusNode = <>Confirm in MetaMask…</>;

  return (
    <main className={s.work}>
      <div className={s.strip}>
        <div className={s.lead}>
          <span className={s.eyebrow}>Realms · SPL Governance</span>
          <h1>
            Cast your vote — <em>directly on SPL Governance</em>.
          </h1>
        </div>
        <span className={s.routepill}>
          <span className={`${s.dot} ${s.evm}`} /> EVM · Rome <span className={s.ar}>→</span> Realms{' '}
          <span className={`${s.dot} ${s.sol}`} />
        </span>
      </div>

      <div className={s.rig}>
        {/* ── ACT: choose + proposal ── */}
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

          <div className={s.tabs}>
            <button type="button" aria-pressed={choice === 'yes'} onClick={() => setChoice('yes')}>
              Yes
            </button>
            <button type="button" aria-pressed={choice === 'no'} onClick={() => setChoice('no')}>
              No
            </button>
          </div>

          <div className={s.field}>
            <label>Proposal</label>
            <div className={s.txt} style={{ minHeight: 'auto', lineHeight: 1.4, whiteSpace: 'normal' }}>
              <div style={{ fontWeight: 500 }}>{proposal?.proposalName ?? '—'}</div>
              {proposal?.proposalDescription && (
                <div className={s.usd} style={{ marginTop: 4 }}>{proposal.proposalDescription}</div>
              )}
            </div>
          </div>

          <div className={s.field}>
            <label>Governing token · {proposal?.governingTokenLabel ?? '—'} mint</label>
            <Address value={proposal?.governingTokenMintBs58} />
          </div>

          <div className={s.field}>
            <label>Proposal pubkey</label>
            <Address value={proposal?.proposalBs58} />
          </div>

          {gateMessage && (
            <div className={s.field}>
              <label style={{ color: 'var(--bad)' }}>Cannot vote yet</label>
              <div className={s.usd} style={{ lineHeight: 1.5 }}>
                {gateMessage}
                {needsRealmsLink && (
                  <>
                    {' '}
                    <a href={REALMS_APP_URL} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>
                      Open app.realms.today →
                    </a>
                  </>
                )}
              </div>
            </div>
          )}

          <div className={s['cta-wrap']}>
            <button className={s.cta} type="submit" disabled={ctaDisabled}>
              <span>{ctaLabel}</span>
              <span className={s.sig}>{ctaCaption}</span>
            </button>
          </div>
        </form>

        {/* ── SEE: ledger + outcome ── */}
        <section className={`${s.col} ${s.see}`}>
          <div className={s.colhd}>
            <span className={s.sd} /> What will happen
            <span className={s.pool}>{proposal?.realmName ?? 'Realms'}</span>
          </div>
          <div className={s.body}>
            <Ledger
              steps={[
                {
                  id: 'vote',
                  label: 'Cast vote on Realms',
                  detail: `cast_vote → Vote::${choiceWord}`,
                  atomic: true,
                },
              ]}
              count={1}
              sub={
                <>
                  One EVM signature → Rome calls SPL Governance&apos;s <b>cast_vote</b> as your Rome PDA on
                  Solana.
                </>
              }
            />
            <div className={s.outcome}>
              <div className={`${s.ln} ${s.get}`}>
                <span className={s.k}>Your vote</span>
                <span className={s.v}>Vote::{choiceWord}</span>
              </div>
              <div className={s.ln}>
                <span className={s.k}>Realm</span>
                <span className={s.v}>{proposal?.realmName ?? '—'}</span>
              </div>
              <div className={s.ln}>
                <span className={s.k}>{proposalState?.isOpen ? 'Voting closes in' : 'Voting status'}</span>
                <span className={s.v}>
                  {proposalState?.loading
                    ? '…'
                    : proposalState?.isOpen && remainingHuman
                      ? remainingHuman
                      : !proposalState?.isOpen && proposalState?.proposalExists
                        ? 'closed'
                        : '—'}
                </span>
              </div>
              <div className={s.note}>
                <b>Yes</b> sends <code>Vote::Approve</code>; <b>No</b> sends <code>Vote::Deny</code>. Abstain
                isn&apos;t offered — SPL Governance rejects it (<code>NotSupportedVoteType</code>), and Veto is
                council-only.
              </div>
            </div>
          </div>
          <div className={s.status}>{statusNode}</div>
        </section>
      </div>
    </main>
  );
};

export { Vote };
