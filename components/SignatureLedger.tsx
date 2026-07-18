'use client';
// SignatureLedger — the "what will happen" panel in the act|see layout.
//
// Renders the LIVE signaturePlan for the connected wallet: a hero count (the
// true number of MetaMask signatures) and the ordered steps — one-time account
// setup first (marked "once"), then the core action. Driven entirely by real
// on-chain account state via useSignaturePlan, so the count the user sees IS
// the count they'll sign. No invented numbers, no demo toggle.
//
// Presentational: takes the useSignaturePlan result, owns no probes. Wire it
// next to each flow's action column.

import type { FlowKind, SigStep } from '../lib/signature-plan';
import styles from './SignatureLedger.module.css';

type Props = {
  flow: FlowKind;
  steps: SigStep[];
  count: number;
  setupCount: number;
  loading?: boolean;
};

// Grounded per-flow copy — the one-liner under the count and the footer note.
// Language matches the design grounding pass: state only what the protocol
// actually does (no APYs, no atomic claims that Rome's per-tx limits forbid).
const COPY: Record<FlowKind, { sub: string; note: string }> = {
  swap: {
    sub: 'One wallet — no bridge, no Phantom, no second account.',
    note: 'First trade into a new token adds one account-creation signature; after that every swap is a single signature.',
  },
  stake: {
    sub: 'You get a liquid stake token you can swap or lend anytime — no unbonding wait to move it.',
    note: 'First stake creates your stake-token account (one extra signature); after that, staking is a single signature.',
  },
  'lend-kamino': {
    sub: 'Kamino needs a one-time lending account + obligation. After that, supplying is a single signature.',
    note: 'Each step is its own atomic transaction — Rome’s per-tx limits mean setup can’t be folded into the supply. The account + obligation are signed once, ever.',
  },
  'lend-drift': {
    sub: 'Drift needs a one-time stats account + user account. After that, depositing is a single signature.',
    note: 'Each step is its own atomic transaction — setup can’t be folded into the deposit. The stats + user accounts are signed once, ever.',
  },
  'pay-streamflow': {
    sub: 'The recipient is a native Solana wallet — no Rome account, no bridge, nothing to set up on their end.',
    note: 'Streamflow creates the recipient’s token account inline, signed by your Rome account — so opening a stream is genuinely one signature.',
  },
  send: {
    sub: 'Send any wrapped SPL to a Solana wallet straight from MetaMask.',
    note: 'If the recipient has never held this token, the first send adds one account-creation signature; after that it’s a single signature.',
  },
};

export function SignatureLedger({ flow, steps, count, setupCount, loading = false }: Props) {
  const copy = COPY[flow];
  const word = count === 1 ? 'signature' : 'signatures';
  const shown = loading ? '·' : String(count);

  return (
    <div className={styles.ledger}>
      <div className={styles.sigbox}>
        <div className={`${styles.big} ${loading ? styles.loading : ''}`}>{shown}</div>
        <div className={styles.lbl}>
          <div className={styles.l1}>
            <b>{loading ? 'Checking your accounts…' : `${count} ${word}`}</b>
            {!loading && ' in MetaMask'}
          </div>
          <div className={styles.l2}>{copy.sub}</div>
        </div>
      </div>

      <ol className={styles.steps}>
        {steps.map((s: SigStep, i: number) => (
          <li key={s.id} className={`${styles.step} ${s.setup ? '' : styles.action}`}>
            <div className={styles.node}>{i + 1}</div>
            <div>
              <div className={styles.head}>
                <span>{s.label}</span>
                {s.atomic && <span className="badge badge-atomic">atomic</span>}
                {s.setup && <span className={styles.once}>once</span>}
              </div>
              {s.detail && (
                <div className={styles.detail}>
                  <code>{s.detail}</code>
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>

      <div className={styles.note}>
        {setupCount > 0 ? copy.note : copy.sub}
      </div>
    </div>
  );
}
