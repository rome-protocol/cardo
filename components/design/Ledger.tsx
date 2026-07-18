'use client';
// Ledger — the "what will happen" content shared by every act|see screen.
// Renders the hero signature count + the ordered, numbered steps from a live
// signaturePlan. Each screen supplies its own one-liner (sub) and wraps this
// with its own outcome rows + status line. Dark palette via the actsee module.

import type { SigStep } from '../../lib/signature-plan';
import s from './actsee.module.css';

export function Ledger({
  steps,
  count,
  loading = false,
  sub,
  countWord,
}: {
  steps: SigStep[];
  count: number;
  loading?: boolean;
  /** one-line context under the count (per-flow copy) */
  sub: React.ReactNode;
  /** noun after the count; defaults to signature/signatures */
  countWord?: string;
}) {
  const word = countWord ?? (count === 1 ? 'signature' : 'signatures');
  return (
    <>
      <div className={s.sigbox}>
        <div className={`${s.big} ${loading ? s.loading : ''}`}>{loading ? '·' : String(count)}</div>
        <div>
          <div className={s.l1}>{loading ? 'checking accounts' : word} in MetaMask</div>
          <div className={s.l2}>{sub}</div>
        </div>
      </div>

      <div className={s.ledtitle}>You will sign, in order</div>
      <ol className={s.steps}>
        {steps.map((st) => (
          <li key={st.id} className={st.setup ? undefined : s.action}>
            <span className={s.n} />
            <div>
              <div className={s.h}>
                {st.label}
                {st.atomic && <span className={s.atomic}>atomic</span>}
                {st.setup && <span className={s.once}>one-time</span>}
              </div>
              {st.detail && (
                <div className={s.d}>
                  <code>{st.detail}</code>
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}
