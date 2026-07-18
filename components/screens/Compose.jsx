'use client';
// Compose screen — act|see. Cardo's in-house DETERMINISTIC orchestrator:
// pick one multi-dapp recipe, see the exact sequence of signatures it
// becomes, and RUN it — each step a real Rome-CPI tx, reconciled from
// on-chain balances between steps (deposit exactly what the swap
// produced, never a guess).
//
// HONEST FRAMING: a multi-dapp intent is N SEQUENTIAL signatures, NOT one
// atomic transaction. Rome's per-tx limits (1232-byte tx / 1.4M CU) mean
// the steps can't fold into one signature; each settles before the next.
// If a step reverts, the run stops and earlier steps stay settled.
// Recipes whose venue is dead on the devnet substrate (perp / Kamino)
// render as honest, disabled previews.

import React, { useState, useMemo, useEffect } from 'react';
import { fmtUSD } from '../primitives';
import s from '../design/actsee.module.css';
import { TxHash, TxError } from '../design/Inline';
import { RECIPES, getRecipe } from '../../lib/compose/recipes';
import { useComposeRun } from '../../lib/compose/use-compose-run';

// Human label + accent for each live step phase.
const PHASE = {
  pending: { label: 'waiting', color: 'var(--muted)' },
  signing: { label: 'sign in wallet', color: 'var(--accent)' },
  confirming: { label: 'confirming', color: 'var(--accent)' },
  reconciling: { label: 'reconciling', color: 'var(--accent)' },
  skipped: { label: 'skipped', color: 'var(--muted)' },
  done: { label: 'done', color: 'var(--ok, #4ea672)' },
  failed: { label: 'failed', color: 'var(--bad, #c9605f)' },
};

export function Compose({ wallet, onConnect }) {
  const [amount, setAmount] = useState('5');
  const [recipeId, setRecipeId] = useState(RECIPES[0].id);
  const recipe = getRecipe(recipeId) ?? RECIPES[0];

  const { state, run, reset, busy } = useComposeRun(recipe);

  // Reset the live ledger when the user switches recipe.
  useEffect(() => {
    reset();
  }, [recipeId, reset]);

  const amt = parseFloat(amount) || 0;
  const n = recipe.steps.length;
  const runnable = recipe.enabled && wallet.connected && amt > 0 && !busy;
  const finished = state.phase === 'done';
  const failed = state.phase === 'failed';

  const ctaLabel = !wallet.connected
    ? 'Connect wallet'
    : !recipe.enabled
      ? 'Preview only'
      : busy
        ? 'Running…'
        : finished
          ? 'Run again'
          : `Run · ${n} step${n === 1 ? '' : 's'}`;

  const ctaCaption = !wallet.connected
    ? 'one wallet — no bridge, no Phantom'
    : !recipe.enabled
      ? recipe.disabledReason
      : busy
        ? 'sign each step in your wallet'
        : `${n} sequential signatures — not one atomic tx`;

  const onCta = () => {
    if (!wallet.connected) return onConnect();
    if (!recipe.enabled || busy) return;
    if (finished || failed) reset();
    run(wallet.address, amount);
  };

  const statusNode = failed
    ? <TxError error={state.error} />
    : finished
      ? <span className={s.ok}>✓ Intent complete — {n} steps settled</span>
      : busy
        ? 'Running — sign each step as your wallet prompts.'
        : recipe.enabled
          ? 'Ready — one signature per step, reconciled between them.'
          : 'Preview · this venue isn’t live on the devnet substrate.';

  return (
    <main className={s.work}>
      <div className={s.strip}>
        <div className={s.lead}>
          <span className={s.eyebrow}>Compose · multi-dapp intents</span>
          <h1>
            One intent, many protocols — <em>run, honestly sequenced</em>.
          </h1>
        </div>
        <span className={s.routepill}>
          <span className={`${s.dot} ${s.evm}`} /> EVM · Rome <span className={s.ar}>→</span> N protocols{' '}
          <span className={`${s.dot} ${s.sol}`} />
        </span>
      </div>

      <div className={s.rig}>
        {/* ── ACT: pick + run the intent ── */}
        <form
          className={`${s.col} ${s.act}`}
          autoComplete="off"
          onSubmit={(e) => {
            e.preventDefault();
            onCta();
          }}
        >
          <div className={s.colhd}>
            <span className={s.sd} /> You do this
          </div>

          <div className={s.leg}>
            <div className={s.r1}>
              <label>Starting amount</label>
              <span className={s.bal}>{recipe.inputToken}</span>
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
                  disabled={busy}
                />
                <div className={s.usd}>≈ {fmtUSD(amt)}</div>
              </div>
              <div className={s.tokchip}>
                <span className={`${s.ic} ${s.usdc}`}>u</span>
                <span className={s.sym}>wUSDC</span>
              </div>
            </div>
          </div>

          <div className={s.field} style={{ borderTop: '1px solid var(--line)' }}>
            <label>Intent</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
              {RECIPES.map((r) => {
                const active = r.id === recipeId;
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => setRecipeId(r.id)}
                    disabled={busy}
                    style={{
                      textAlign: 'left',
                      background: active
                        ? 'color-mix(in srgb, var(--accent) 10%, transparent)'
                        : 'var(--ground-3)',
                      border: `1px solid ${active ? 'var(--accent)' : 'var(--line)'}`,
                      borderRadius: 'var(--r)',
                      padding: '11px 13px',
                      cursor: busy ? 'default' : 'pointer',
                      opacity: r.enabled ? 1 : 0.6,
                    }}
                  >
                    <div
                      style={{
                        fontFamily: 'var(--mono)',
                        fontSize: 12.5,
                        color: active ? 'var(--accent)' : 'var(--text)',
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: 8,
                      }}
                    >
                      <span>{r.title}</span>
                      {!r.enabled && (
                        <span style={{ fontSize: 10.5, color: 'var(--muted)', letterSpacing: '.04em' }}>
                          PREVIEW
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 3, lineHeight: 1.5 }}>
                      {r.enabled ? r.summary : r.disabledReason}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className={s['cta-wrap']}>
            <button className={s.cta} type="submit" disabled={wallet.connected && !recipe.enabled && !busy ? true : busy}>
              <span>{ctaLabel}</span>
              <span className={s.sig}>{ctaCaption}</span>
            </button>
          </div>
        </form>

        {/* ── SEE: the live sequence ── */}
        <section className={`${s.col} ${s.see}`}>
          <div className={s.colhd}>
            <span className={s.sd} /> What will happen
            <span className={s.pool}>{n} steps across protocols</span>
          </div>
          <div className={s.body}>
            <div className={s.sigbox}>
              <div className={s.big}>{n}</div>
              <div>
                <div className={s.l1}>signatures, in sequence</div>
                <div className={s.l2}>
                  One per step — <b>not</b> a single atomic transaction.
                </div>
              </div>
            </div>

            <div className={s.ledtitle}>
              {busy || finished || failed ? 'Running, in order' : 'You will sign, in order'}
            </div>
            <ol className={s.steps}>
              {state.steps.map((step, i) => {
                const ph = PHASE[step.phase] ?? PHASE.pending;
                const activeStep = state.activeIndex === i && busy;
                return (
                  <li key={step.id} style={{ opacity: step.phase === 'pending' && !recipe.enabled ? 0.6 : 1 }}>
                    <span
                      className={s.n}
                      style={activeStep ? { borderColor: 'var(--accent)', background: 'color-mix(in srgb, var(--accent) 18%, transparent)' } : undefined}
                    />
                    <div>
                      <div className={s.h}>
                        {step.title} <span className={s.once}>{step.venue}</span>
                        <span style={{ marginLeft: 8, fontSize: 10.5, letterSpacing: '.04em', color: ph.color }}>
                          {recipe.enabled ? ph.label.toUpperCase() : 'PREVIEW'}
                        </span>
                      </div>
                      <div className={s.d}>{step.detail || step.note}</div>
                      {step.hash && (
                        <div className={s.d} style={{ marginTop: 3 }}>
                          <TxHash hash={step.hash} />
                        </div>
                      )}
                      {step.error && (
                        <div style={{ marginTop: 3 }}>
                          <TxError error={step.error} />
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>

            <div className={s.outcome}>
              <div className={s.note}>
                Rome&apos;s per-tx limits (1232-byte tx · 1.4M CU) mean a multi-dapp intent can&apos;t
                fold into one signature — it runs as <b>{n} sequential steps</b>, each settling before
                the next. The deposit uses the <b>real balance the swap produced</b>, reconciled
                on-chain between steps — never a guess. Atomic all-or-nothing bundling (via Jito) is a
                separate path, not wired here.
              </div>
            </div>
          </div>
          <div className={s.status}>{statusNode}</div>
        </section>
      </div>
    </main>
  );
}
