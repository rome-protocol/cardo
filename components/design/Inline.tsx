'use client';
// Shared inline display primitives for act|see screens. One home for rendering a
// tx hash, an address, an error, and a tx status line — so nothing dumps a raw
// blob and a MetaMask reject reads as "cancelled", not "reverted".

import { useState, type ReactNode } from 'react';
import { explorerTxUrl } from '../../lib/chain-config';
import { isUserRejection, summarizeTxError, truncateMiddle } from '../../lib/tx-errors';
import s from './actsee.module.css';

export function CopyButton({ text, title = 'Copy' }: { text: string; title?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={s.copybtn}
      title={title}
      aria-label={title}
      onClick={async (e) => {
        e.stopPropagation();
        e.preventDefault();
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch {
          /* clipboard blocked — no-op */
        }
      }}
    >
      {done ? '✓' : '⧉'}
    </button>
  );
}

/** A settled tx: truncated hash → explorer + a copy button. Defaults to the Via
 *  (Rome) explorer; pass `href` to point at another chain's explorer (e.g. the
 *  Sepolia side of a bridge burn). */
export function TxHash({ hash, label, href }: { hash?: string; label?: string; href?: string }) {
  if (!hash) return null;
  return (
    <span className={s.inlinepill}>
      <a href={href ?? explorerTxUrl(hash)} target="_blank" rel="noreferrer" title={hash}>
        {label ?? truncateMiddle(hash, 6, 4)} ↗
      </a>
      <CopyButton text={hash} title="Copy transaction hash" />
    </span>
  );
}

/** An address/pubkey: truncated + copy (never dumped full). */
export function Address({ value, title }: { value?: string; title?: string }) {
  if (!value) return null;
  return (
    <span className={s.inlinepill}>
      <span className={s.mono} title={title ?? value}>{truncateMiddle(value, 4, 4)}</span>
      <CopyButton text={value} title="Copy address" />
    </span>
  );
}

/** A concise error. A user rejection reads neutral ("cancelled"); a real revert
 *  shows a one-line summary with the raw detail tucked behind an expander. */
export function TxError({ error }: { error?: unknown }) {
  if (!error) return null;
  if (isUserRejection(error)) return <span className={s.cancelled}>Transaction cancelled</span>;
  const summary = summarizeTxError(error);
  const raw = typeof error === 'string' ? error : ((error as { message?: string })?.message ?? '');
  const hasMore = !!raw && raw.length > summary.length + 4;
  return (
    <span className={s.bad}>
      {summary}
      {hasMore ? (
        <details className={s.errdetails}>
          <summary>details</summary>
          <span className={s.mono}>{raw}</span>
        </details>
      ) : null}
    </span>
  );
}

type PhaseState = { phase?: string; error?: unknown; hash?: string };

/** The whole status line for a flow: idle → busy → success/cancelled/reverted.
 *  Pass a custom `success` node (per-flow copy); cancelled + reverted are handled
 *  uniformly so a MetaMask reject never reads as a failure. */
export function TxStatus({
  state,
  idle,
  busy,
  success,
}: {
  state?: PhaseState;
  idle?: ReactNode;
  busy?: ReactNode;
  success?: ReactNode;
}) {
  const phase = state?.phase ?? 'idle';
  if (phase === 'success') return <>{success ?? <span className={s.ok}>✓ Done</span>}</>;
  if (phase === 'failed') {
    if (isUserRejection(state?.error)) return <span className={s.cancelled}>Transaction cancelled</span>;
    return <span className={s.bad}>Reverted · {summarizeTxError(state?.error)}</span>;
  }
  if (phase === 'signing' || phase === 'confirming') return <>{busy ?? <>Confirm in MetaMask…</>}</>;
  return <>{idle ?? <>Preview · this is exactly what your wallet will sign</>}</>;
}
