'use client';
// WrapperGate — "EVM-side wrapper exists or deploy it" gate. Wrap an adapter
// screen that needs an ERC20-SPL wrapper for a specific Solana mint; the gate
// detects / deploys / binds and only renders children when the wrapper is
// usable. Styled in the act|see dark design so it sits correctly inside
// DesignShell (the .shell ancestor supplies the palette).
//
// States: checking (neutral card) · exists/ready (children, no chrome) ·
// missing/working (deploy CTA with editable symbol/name).

import React, { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Address } from 'viem';
import { ViaLink } from './design/ViaLink';
import { useEnsureWrapper } from '../lib/use-ensure-wrapper';
import { recommendSymbol } from '../lib/wrapper-fabric';
import s from './design/actsee.module.css';

type Props = {
  mintBs58: string | null;
  userAddress?: Address;
  defaultSymbol?: string;
  defaultName?: string;
  sourceSymbolHint?: string;
  children: ReactNode;
};

export function WrapperGate({
  mintBs58,
  userAddress,
  defaultSymbol,
  defaultName,
  sourceSymbolHint,
  children,
}: Props) {
  const { state, ensure } = useEnsureWrapper(mintBs58);

  const recommended = useMemo(() => {
    if (!mintBs58) return { symbol: '', name: '' };
    const r = recommendSymbol({ mintBs58, sourceSymbol: sourceSymbolHint });
    return { symbol: defaultSymbol ?? r.symbol, name: defaultName ?? r.name };
  }, [mintBs58, sourceSymbolHint, defaultSymbol, defaultName]);

  const [symbol, setSymbol] = useState(recommended.symbol);
  const [name, setName] = useState(recommended.name);
  useEffect(() => {
    setSymbol(recommended.symbol);
    setName(recommended.name);
  }, [recommended.symbol, recommended.name]);

  // Pass-through: no mint, or wrapper already usable.
  if (!mintBs58 || state.phase === 'exists' || state.phase === 'ready') {
    return <>{children}</>;
  }

  const short = `${mintBs58.slice(0, 8)}…${mintBs58.slice(-4)}`;

  if (state.phase === 'unknown' || state.phase === 'checking') {
    return (
      <main className={s.work}>
        <div className={s.pfpanel} style={{ maxWidth: 600 }}>
          <span className={s.eyebrow}>Checking EVM wrapper</span>
          <p style={{ marginTop: 8, marginBottom: 0, color: 'var(--muted)', fontSize: 13 }}>
            Looking up an ERC20-SPL wrapper on Rome for mint <span className="mono">{short}</span>.
          </p>
        </div>
      </main>
    );
  }

  if (state.phase === 'failed') {
    return (
      <main className={s.work}>
        <div className={s.pfpanel} style={{ maxWidth: 600 }}>
          <span className={s.eyebrow}>Wrapper lookup failed</span>
          <p style={{ marginTop: 8, marginBottom: 0, color: 'var(--bad)', fontSize: 13, wordBreak: 'break-word' }}>
            {state.error ?? 'Unknown error'}
          </p>
        </div>
      </main>
    );
  }

  // 'missing' / 'creating-user' / 'deploying-wrapper' / 'binding-account'
  const isWorking =
    state.phase === 'creating-user' ||
    state.phase === 'deploying-wrapper' ||
    state.phase === 'binding-account';

  return (
    <main className={s.work}>
      <div className={s.pfpanel} style={{ maxWidth: 640 }}>
        <span className={s.eyebrow}>EVM wrapper missing</span>
        <div className={s.lead}>
          <h1 style={{ marginTop: 6 }}>
            Deploy a wrapper, <em>then continue</em>.
          </h1>
        </div>
        <p style={{ marginTop: 12, color: 'var(--muted)', fontSize: 13, lineHeight: 1.6 }}>
          The Solana mint <span className="mono">{short}</span> doesn&apos;t have an ERC20-SPL surface on
          Rome yet. Cardo deploys one through the canonical factory and binds your wallet to it — three
          one-time signatures (skips user-registration if you already hold any wrapper).
        </p>

        <div className={s.field} style={{ borderTop: 'none', padding: '8px 0 0' }}>
          <label>Symbol (unique on the factory)</label>
          <input className={s.txt} type="text" value={symbol} onChange={(e) => setSymbol(e.target.value)} disabled={isWorking} />
        </div>
        <div className={s.field} style={{ borderTop: 'none', padding: '8px 0 0' }}>
          <label>Name</label>
          <input className={s.txt} type="text" value={name} onChange={(e) => setName(e.target.value)} disabled={isWorking} />
        </div>

        <button
          className={s.cta}
          style={{ marginTop: 18 }}
          disabled={!userAddress || !symbol || !name || isWorking}
          onClick={() => userAddress && ensure({ userAddress, symbol, name })}
        >
          <span>
            {state.phase === 'missing' && (userAddress ? 'Deploy wrapper' : 'Connect wallet')}
            {state.phase === 'creating-user' && 'Registering user…'}
            {state.phase === 'deploying-wrapper' && 'Deploying wrapper…'}
            {state.phase === 'binding-account' && 'Binding your account…'}
          </span>
        </button>

        {state.hash && (
          <div style={{ marginTop: 10, fontSize: 12 }}>
            <ViaLink hash={state.hash} />
          </div>
        )}
      </div>
    </main>
  );
}
