'use client';
// WrapPrompt — pre-flight CTA when an adapter needs the user to top up
// their chain_mint_id SPL ATA from native gas. One signature; ~50K CU.
//
// SCOPE: ONLY for the chain's gas-backing mint (WUSDC on Rome). For
// every other ERC20-SPL wrapper, the wrapper's `balanceOf` already
// reads the live ATA balance — no wrap step needed; do not surface
// this component there.
//
// Usage:
//   <WrapPrompt
//     userAddress={wallet.address}
//     desiredSpendHuman={form.amount}
//     ataBalanceHuman={ataBalanceUSDC}
//     gasBalanceHuman={nativeBalanceUSDC}
//     onWrapped={() => refetchBalances()}
//   />
//
// The prompt renders nothing when the user already has enough SPL in
// their ATA. It renders an error state when the deficit can't be
// covered by gas. Otherwise it renders a CTA with the auto-computed
// wrap amount (editable).

import React, { useEffect, useMemo, useState } from 'react';
import type { Address } from 'viem';
import { Eyebrow, fmtNum } from './primitives';
import { useWrapGasToSpl } from '../lib/use-wrap-gas';
import { uiAmountToWei } from '../lib/wrap-unwrap-fabric';

type Props = {
  userAddress: Address | undefined;
  /// Amount the user is about to spend in the chain_mint_id SPL.
  /// In UI units (e.g. 5.0 USDC at 6 decimals).
  desiredSpendHuman: number;
  /// Live ATA balance of the chain_mint_id SPL, UI units.
  ataBalanceHuman: number;
  /// Live native gas balance, UI units (interpreted as the same human
  /// units as the SPL — both back the chain_mint_id, 1:1).
  gasBalanceHuman: number;
  /// Symbol shown in copy (e.g. "WUSDC"). Defaults to "WUSDC" since
  /// chain_mint_id on Rome is Circle USDC.
  symbol?: string;
  /// Fired after a successful wrap so the parent can refetch balances
  /// and let the user proceed.
  onWrapped?: () => void;
};

export function WrapPrompt({
  userAddress,
  desiredSpendHuman,
  ataBalanceHuman,
  gasBalanceHuman,
  symbol = 'WUSDC',
  onWrapped,
}: Props) {
  const deficit = Math.max(0, desiredSpendHuman - ataBalanceHuman);
  const { state, wrap } = useWrapGasToSpl();
  const [override, setOverride] = useState<string>('');

  // Default the input to the exact deficit; user can edit.
  const wrapAmount = useMemo(() => {
    const n = parseFloat(override);
    if (Number.isFinite(n) && n > 0) return n;
    return deficit;
  }, [override, deficit]);

  // When a wrap succeeds, signal the parent so it can refetch.
  useEffect(() => {
    if (state.phase === 'success' && onWrapped) onWrapped();
  }, [state.phase, onWrapped]);

  // Pass-through: nothing to do.
  if (deficit <= 0) return null;

  const insufficientGas = deficit > gasBalanceHuman;
  const phase = state.phase;
  const isWorking = phase === 'signing' || phase === 'confirming';

  return (
    <div
      className="card"
      style={{
        padding: 18,
        marginBottom: 16,
        borderColor: insufficientGas ? 'rgba(207,82,46,0.4)' : 'rgba(94,10,96,0.28)',
        background: insufficientGas
          ? 'linear-gradient(180deg, rgba(255,238,232,0.6), var(--bg-surface))'
          : 'linear-gradient(180deg, rgba(249,227,242,0.45), var(--bg-surface))',
      }}
    >
      <Eyebrow>Top up {symbol} from gas</Eyebrow>
      <p
        className="small"
        style={{ marginTop: 8, marginBottom: 0, color: 'var(--fg2)', lineHeight: 1.55 }}
      >
        You're about to spend <span className="mono">{fmtNum(desiredSpendHuman, 4)} {symbol}</span>
        , but your ATA on Solana holds only{' '}
        <span className="mono">{fmtNum(ataBalanceHuman, 4)} {symbol}</span>.
        Wrap{' '}
        <span className="mono">{fmtNum(deficit, 4)}</span> from your native
        gas balance to cover the rest. <em>One signature, ~50K CU.</em>
      </p>

      {insufficientGas ? (
        <div className="small" style={{ marginTop: 12, color: '#cf522e' }}>
          You don't have enough native gas ({fmtNum(gasBalanceHuman, 4)}) to
          cover the deficit. Bridge in more before continuing.
        </div>
      ) : (
        <>
          <div style={{ marginTop: 14, display: 'grid', gap: 10 }}>
            <div className="row" style={{ gap: 6 }}>
              <input
                type="number"
                inputMode="decimal"
                value={override === '' ? deficit.toString() : override}
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

          <button
            className="btn btn-primary"
            disabled={
              !userAddress ||
              wrapAmount <= 0 ||
              wrapAmount > gasBalanceHuman ||
              isWorking
            }
            onClick={() => userAddress && wrap(uiAmountToWei(wrapAmount))}
            style={{ marginTop: 14 }}
          >
            {phase === 'signing' && 'Awaiting signature…'}
            {phase === 'confirming' && 'Confirming…'}
            {phase === 'success' && 'Wrapped ✓'}
            {phase === 'failed' && 'Failed — try again'}
            {phase === 'idle' &&
              `Wrap ${fmtNum(wrapAmount, 4)} ${symbol}`}
          </button>

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
        </>
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
