'use client';
// UnwrapPrompt — post-trade CTA when an adapter call leaves
// chain_mint_id SPL in the user's PDA-owned ATA. User can unwrap to
// native gas (one signature) OR leave it in the ATA for later.
//
// SCOPE: ONLY for the chain's gas-backing mint (WUSDC on Rome). For
// every other ERC20-SPL wrapper, the SPL in the ATA already shows up
// as wrapper.balanceOf — no unwrap step needed; do not surface this
// component there.
//
// No persistence layer: the prompt detects "ATA balance > 0" each
// render and offers the action. User can defer indefinitely; SPL stays
// in the ATA until they pick up the prompt next visit.

import React, { useEffect, useMemo, useState } from 'react';
import type { Address } from 'viem';
import { Eyebrow, fmtNum } from './primitives';
import { useUnwrapSplToGas } from '../lib/use-wrap-gas';
import { uiAmountToWei } from '../lib/wrap-unwrap-fabric';

type Props = {
  userAddress: Address | undefined;
  /// Live ATA balance of the chain_mint_id SPL, UI units.
  ataBalanceHuman: number;
  symbol?: string;
  /// Fired after a successful unwrap so the parent can refetch.
  onUnwrapped?: () => void;
  /// Optional minimum balance below which the prompt stays hidden.
  /// Defaults to 0 (any positive balance shows the prompt).
  minBalance?: number;
  /// Optional copy override — adapter pages can pass a context-specific
  /// "this came from {trade}" line.
  contextLine?: string;
};

export function UnwrapPrompt({
  userAddress,
  ataBalanceHuman,
  symbol = 'WUSDC',
  onUnwrapped,
  minBalance = 0,
  contextLine,
}: Props) {
  const { state, unwrap } = useUnwrapSplToGas();
  const [override, setOverride] = useState<string>('');

  const unwrapAmount = useMemo(() => {
    const n = parseFloat(override);
    if (Number.isFinite(n) && n > 0) return n;
    return ataBalanceHuman;
  }, [override, ataBalanceHuman]);

  useEffect(() => {
    if (state.phase === 'success' && onUnwrapped) onUnwrapped();
  }, [state.phase, onUnwrapped]);

  if (ataBalanceHuman <= minBalance) return null;

  const phase = state.phase;
  const isWorking = phase === 'signing' || phase === 'confirming';
  const exceedsBalance = unwrapAmount > ataBalanceHuman;

  return (
    <div
      className="card"
      style={{
        padding: 18,
        marginTop: 16,
        background: 'linear-gradient(180deg, rgba(232,242,236,0.4), var(--bg-surface))',
        borderColor: 'rgba(59,140,94,0.32)',
      }}
    >
      <Eyebrow>Unwrap to native gas (optional)</Eyebrow>
      <p
        className="small"
        style={{ marginTop: 8, marginBottom: 0, color: 'var(--fg2)', lineHeight: 1.55 }}
      >
        {contextLine
          ? contextLine + ' '
          : `${fmtNum(ataBalanceHuman, 4)} ${symbol} is sitting in your Solana ATA. `}
        You can unwrap any amount back to native gas, or leave it in the ATA
        and unwrap later — either is fine.
      </p>

      <div style={{ marginTop: 14, display: 'grid', gap: 10 }}>
        <div className="row" style={{ gap: 6 }}>
          <input
            type="number"
            inputMode="decimal"
            value={override === '' ? ataBalanceHuman.toString() : override}
            onChange={(e) => setOverride(e.target.value)}
            disabled={isWorking}
            style={inputStyle()}
          />
          <span
            className="mono small"
            style={{ paddingTop: 14, color: 'var(--fg2)' }}
          >
            {symbol}
          </span>
        </div>
      </div>

      <div className="row" style={{ gap: 8, marginTop: 14 }}>
        <button
          className="btn btn-primary"
          disabled={
            !userAddress || unwrapAmount <= 0 || exceedsBalance || isWorking
          }
          onClick={() =>
            userAddress && unwrap(uiAmountToWei(unwrapAmount))
          }
        >
          {phase === 'signing' && 'Awaiting signature…'}
          {phase === 'confirming' && 'Confirming…'}
          {phase === 'success' && 'Unwrapped ✓'}
          {phase === 'failed' && 'Failed — try again'}
          {phase === 'idle' &&
            `Unwrap ${fmtNum(unwrapAmount, 4)} ${symbol}`}
        </button>
        <span className="small" style={{ paddingTop: 10, color: 'var(--fg2)' }}>
          or leave in ATA
        </span>
      </div>

      {exceedsBalance && (
        <div className="tiny" style={{ marginTop: 8, color: '#cf522e' }}>
          Amount exceeds your ATA balance ({fmtNum(ataBalanceHuman, 4)}).
        </div>
      )}
      {phase === 'failed' && state.error && (
        <div
          className="small"
          style={{ marginTop: 8, color: '#cf522e', wordBreak: 'break-word' }}
        >
          {state.error}
        </div>
      )}
      {state.hash && (
        <div
          className="small mono"
          style={{ marginTop: 6, color: 'var(--fg2)', wordBreak: 'break-all' }}
        >
          tx {state.hash}
        </div>
      )}
    </div>
  );
}

const inputStyle = (): React.CSSProperties => ({
  width: '100%',
  padding: 10,
  fontSize: 15,
  background: 'var(--bg-base)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 10,
  color: 'var(--fg1)',
  fontFamily: 'var(--font-mono)',
});
