'use client';
// GasWrapCard — act|see Portfolio widget to convert native gas ↔ the chain-mint
// wrapper (USDC ↔ wUSDC on Hadrian), like the Rome web app's Portfolio wrap/unwrap.
//
// Chain-generic: the gas symbol comes from chain-config nativeCurrency; the
// wrapper is its `w`-prefixed ERC20-SPL. ONLY the chain's gas-backing mint needs
// a wrap step — every other wrapper IS its ATA. Wired to the existing
// useWrapGasToSpl / useUnwrapSplToGas hooks (withdraw_to_ata / deposit_from_ata).

import React, { useState } from 'react';
import { useBalance, useChainId, useSwitchChain } from 'wagmi';
import type { Address } from 'viem';
import { fmtNum } from './primitives';
import { useActiveChainId } from '../lib/env-context';
import { activeChain } from '../lib/chain-config';
import { useWrapGasToSpl, useUnwrapSplToGas } from '../lib/use-wrap-gas';
import { uiAmountToWei } from '../lib/wrap-unwrap-fabric';
import { ViaLink } from './design/ViaLink';
import s from './design/actsee.module.css';

export function GasWrapCard({
  userAddress,
  wrapperBalance = 0,
}: {
  userAddress?: Address;
  wrapperBalance?: number;
}) {
  const chainId = useActiveChainId();
  const walletChainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  const cfg = activeChain(chainId);
  const gasSym = cfg.nativeCurrency.symbol; // e.g. USDC on Hadrian
  const wrapSym = `w${gasSym}`; // wUSDC

  const [mode, setMode] = useState<'wrap' | 'unwrap'>('wrap');
  const [amount, setAmount] = useState('');
  const { state: wrapState, wrap } = useWrapGasToSpl();
  const { state: unwrapState, unwrap } = useUnwrapSplToGas();
  const { data: gasBal } = useBalance({ address: userAddress, chainId });

  const isWrap = mode === 'wrap';
  const gasHuman = gasBal ? Number(gasBal.formatted) : 0;
  const srcBal = isWrap ? gasHuman : wrapperBalance;
  const srcSym = isWrap ? gasSym : wrapSym;
  const dstSym = isWrap ? wrapSym : gasSym;
  const a = parseFloat(amount) || 0;
  const [submitting, setSubmitting] = useState(false);
  const st = isWrap ? wrapState : unwrapState;
  const busy = st.phase === 'signing' || st.phase === 'confirming';
  // Disabled from the first click through settle. `submitting` covers the async
  // gap BEFORE the hook sets `signing` (chain-switch + on-chain estimate), which
  // otherwise let a second click fire a second tx ("waiting on previous").
  const pending = submitting || busy;

  const onSubmit = async () => {
    if (!userAddress || a <= 0 || pending) return; // re-entry guard → exactly one tx
    setSubmitting(true);
    try {
      // Wrap/unwrap are Rome writes — ensure the wallet is on the Rome chain (it
      // may be left on Sepolia after a bridge), else the tx hits the wrong chain.
      if (walletChainId !== chainId) await switchChainAsync({ chainId });
      if (isWrap) await wrap(uiAmountToWei(a));
      else await unwrap(uiAmountToWei(a));
    } catch {
      /* surfaced via hook state, or user-rejected */
    } finally {
      setSubmitting(false);
    }
  };

  let label = isWrap ? `Wrap ${gasSym} → ${wrapSym}` : `Unwrap ${wrapSym} → ${gasSym}`;
  if (busy) label = st.phase === 'signing' ? 'Awaiting signature…' : 'Confirming…';
  else if (submitting) label = 'Preparing…';
  else if (a > srcBal) label = `Insufficient ${srcSym}`;

  return (
    <div className={s.pfpanel}>
      <h3>Wrap / unwrap gas</h3>
      <div className={s.d} style={{ color: 'var(--muted)', fontSize: 12.5, lineHeight: 1.55, marginBottom: 12 }}>
        {gasSym} is this chain&apos;s native gas; {wrapSym} is its ERC20-SPL wrapper (what swaps and
        dapps spend). Convert between them — one signature, settled on Solana.
      </div>

      <div className={s.tabs}>
        <button type="button" aria-pressed={isWrap} onClick={() => setMode('wrap')}>Wrap</button>
        <button type="button" aria-pressed={!isWrap} onClick={() => setMode('unwrap')}>Unwrap</button>
      </div>

      <div className={s.r1} style={{ marginTop: 12 }}>
        <label>You {mode}</label>
        <span className={s.bal}>balance <b>{fmtNum(srcBal)}</b> {srcSym}</span>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
        <input
          className={s.amt}
          inputMode="decimal"
          aria-label="Wrap amount"
          placeholder="0.00"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          style={{ flex: 1 }}
        />
        <button type="button" className={`${s.btn} ${s.ghost}`} onClick={() => setAmount(srcBal > 0 ? String(srcBal) : '')}>
          Max
        </button>
      </div>

      <button
        type="button"
        className={s.btn}
        style={{ width: '100%', marginTop: 12 }}
        disabled={!userAddress || a <= 0 || a > srcBal || pending}
        onClick={onSubmit}
      >
        {label}
      </button>

      <div className={s.status} style={{ marginTop: 10 }}>
        {st.phase === 'success' ? (
          <>
            <span className={s.ok}>✓ {isWrap ? 'Wrapped' : 'Unwrapped'}</span>
            {st.hash ? <> · <ViaLink hash={st.hash} /></> : null}
          </>
        ) : st.phase === 'failed' ? (
          <span className={s.bad}>Reverted · {(st.error ?? 'try again').slice(0, 50)}</span>
        ) : (
          <>You receive {fmtNum(a, 4)} {dstSym}</>
        )}
      </div>
    </div>
  );
}
