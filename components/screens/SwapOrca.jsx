'use client';
// SwapOrca screen — Cardo /swap-orca. Direct Orca Whirlpool swap on
// devnet using an existing funded WSOL/USDC pool.
//
// Per the integration roadmap at
//   the integration roadmap
// (Family 3 — A1 → A0 promotion via existing devnet liquidity).

import React, { useEffect, useMemo, useState } from 'react';
import { Eyebrow, fmtNum } from '../primitives';
import { TxError, TxHash } from '../design/Inline';

const SwapOrca = ({
  wallet,
  onConnect,
  /// Active Orca pool (from registry).
  pool,
  /// Live pool state — { currentTick, sqrtPriceX64, liquidity, loading }
  poolState,
  /// User's per-mint ATA balance on Solana, keyed by mint bs58.
  /// Number, in UI units.
  ataBalancesByMint = {},
  /// Submit handler.
  ///   ({ aToB, amountHuman }) → void
  onSwap,
  onSwapV2,
  swapV2State,
  swapState,
}) => {
  const [direction, setDirection] = useState('a_to_b'); // a_to_b: WSOL → USDC; b_to_a: USDC → WSOL
  const [amount, setAmount] = useState('');

  const aToB = direction === 'a_to_b';
  const inSym = aToB ? pool?.symbolA : pool?.symbolB;
  const outSym = aToB ? pool?.symbolB : pool?.symbolA;
  const inMint = aToB ? pool?.tokenMintA : pool?.tokenMintB;
  const inDecimals = aToB ? pool?.tokenDecimalsA : pool?.tokenDecimalsB;
  const inBalance = inMint ? (ataBalancesByMint[inMint] ?? 0) : 0;

  const amt = parseFloat(amount) || 0;
  const insufficient = amt > 0 && amt > inBalance;
  const phase = swapState?.phase ?? 'idle';
  const isWorking = phase === 'signing' || phase === 'confirming';

  const tickReady = poolState?.currentTick !== undefined;
  const noLiquidity = poolState?.liquidity !== undefined && poolState.liquidity === 0n;

  const submitDisabled =
    !wallet?.connected ||
    !pool ||
    !tickReady ||
    noLiquidity ||
    amt <= 0 ||
    insufficient ||
    isWorking;

  // Reset amount when direction toggles.
  useEffect(() => { setAmount(''); }, [direction]);

  return (
    <main className="container" style={{ padding: '40px 32px 96px' }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 28, alignItems: 'flex-end', flexWrap: 'wrap', gap: 16 }}>
        <div>
          <Eyebrow>Cardo Swap · Orca Whirlpools</Eyebrow>
          <h1 className="h2" style={{ marginTop: 6 }}>
            Swap WSOL ↔ USDC, <em>directly on Orca.</em>
          </h1>
        </div>
        <div className="row" style={{ gap: 20 }}>
          <Stat k={`${inSym} on Solana`} v={fmtNum(inBalance, 4)} />
          <Stat k="Pool tick" v={poolState?.currentTick ?? '—'} />
        </div>
      </div>

      {!wallet?.connected && (
        <div className="card" style={{ padding: 18, marginBottom: 24 }}>
          <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
            <div>
              <Eyebrow>Connect to swap</Eyebrow>
              <p className="small" style={{ marginTop: 6, marginBottom: 0, color: 'var(--fg2)' }}>
                One EVM signature → Rome calls Orca's <span className="mono">swap</span> ix on Solana, signed as your Rome PDA. Pool tokens move directly between your ATAs.
              </p>
            </div>
            <button className="btn btn-primary" onClick={onConnect}>Connect wallet</button>
          </div>
        </div>
      )}

      <div className="card" style={{ padding: 28, maxWidth: 600 }}>
        <Field label="Pool">
          <div className="mono small" style={{ color: 'var(--fg1)' }}>
            {pool?.label ?? '—'}
          </div>
          <div className="tiny" style={{ marginTop: 4, color: 'var(--fg2)' }}>
            tick_spacing {pool?.tickSpacing} · liquidity {' '}
            {poolState?.liquidity !== undefined
              ? poolState.liquidity.toString()
              : '…'}
          </div>
        </Field>

        <Field label="Direction">
          <div className="row" style={{ gap: 6 }}>
            <button
              onClick={() => setDirection('a_to_b')}
              className="btn"
              style={{
                background: aToB ? 'var(--rome-purple)' : 'transparent',
                color: aToB ? 'var(--bg-base)' : 'var(--fg1)',
                borderColor: aToB ? 'var(--rome-purple)' : 'var(--border-subtle)',
              }}
            >
              {pool?.symbolA} → {pool?.symbolB}
            </button>
            <button
              onClick={() => setDirection('b_to_a')}
              className="btn"
              style={{
                background: !aToB ? 'var(--rome-purple)' : 'transparent',
                color: !aToB ? 'var(--bg-base)' : 'var(--fg1)',
                borderColor: !aToB ? 'var(--rome-purple)' : 'var(--border-subtle)',
              }}
            >
              {pool?.symbolB} → {pool?.symbolA}
            </button>
          </div>
        </Field>

        <Field
          label="Amount"
          hint={
            insufficient
              ? `Exceeds ATA balance (${fmtNum(inBalance, 4)} ${inSym}).`
              : noLiquidity
                ? 'Pool has 0 active liquidity at the current tick — no swap possible.'
                : ''
          }
          hintColor={insufficient || noLiquidity ? '#cf522e' : undefined}
        >
          <div className="row" style={{ gap: 6 }}>
            <input
              type="number"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              style={{ ...inputStyle(), fontFamily: 'var(--font-mono)' }}
            />
            <span className="mono small" style={{ paddingTop: 14, color: 'var(--fg2)' }}>
              {inSym}
            </span>
          </div>
        </Field>

        <div className="card" style={{ padding: 14, background: 'var(--bg-base)', marginTop: 14 }}>
          <div className="tiny" style={{ textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--fg2)', marginBottom: 8 }}>
            What this does
          </div>
          <div className="small" style={{ color: 'var(--fg1)', lineHeight: 1.5 }}>
            Sign one EVM transaction → Rome calls Orca's{' '}
            <span className="mono">swap</span> ix, signed as your Rome PDA.
            v1 ships with no slippage protection (other_amount_threshold = 0)
            for testing. Don't use for non-trivial amounts until slippage is wired.
          </div>
        </div>

        <button
          className="btn btn-primary btn-xl"
          disabled={submitDisabled}
          onClick={() => onSwap?.({ aToB, amountHuman: amt })}
          style={{ marginTop: 24, width: '100%', opacity: submitDisabled ? 0.5 : 1 }}
        >
          {phase === 'signing' && 'Awaiting signature…'}
          {phase === 'confirming' && 'Confirming on Solana…'}
          {phase === 'success' && 'Swapped ✓'}
          {phase === 'failed' && 'Failed — try again'}
          {phase === 'idle' && (wallet?.connected ? `Swap ${inSym} → ${outSym}` : 'Connect wallet')}
        </button>

        {phase === 'failed' && swapState?.error && (
          <div className="small" style={{ marginTop: 10 }}>
            <TxError error={swapState.error} />
          </div>
        )}
        {(phase === 'confirming' || phase === 'success') && swapState?.hash && (
          <div className="small" style={{ marginTop: 10 }}>
            tx <TxHash hash={swapState.hash} />
          </div>
        )}

        {onSwapV2 && (
          <button
            className="btn"
            disabled={submitDisabled}
            onClick={() => onSwapV2?.({ aToB, amountHuman: amt })}
            style={{ marginTop: 8, width: '100%', opacity: submitDisabled ? 0.5 : 1 }}
            title="Same accounts as swap, plus Token-2022 program references and the Memo program. Required for pools whose mints implement transfer extensions."
          >
            {swapV2State?.phase === 'signing' && 'Awaiting signature…'}
            {swapV2State?.phase === 'confirming' && 'Confirming on Solana…'}
            {swapV2State?.phase === 'success' && 'Swapped via swap_v2 ✓'}
            {swapV2State?.phase === 'failed' && 'swap_v2 failed — try again'}
            {(!swapV2State || swapV2State.phase === 'idle') &&
              `Swap ${inSym} → ${outSym} via swap_v2 (Token-2022 mode)`}
          </button>
        )}
        {swapV2State?.phase === 'failed' && swapV2State.error && (
          <div className="small" style={{ marginTop: 10 }}><TxError error={swapV2State.error} /></div>
        )}
        {(swapV2State?.phase === 'confirming' || swapV2State?.phase === 'success') && swapV2State.hash && (
          <div className="small" style={{ marginTop: 10 }}>
            v2 tx <TxHash hash={swapV2State.hash} />
          </div>
        )}
      </div>
    </main>
  );
};

const Field = ({ label, hint, hintColor, children }) => (
  <div style={{ marginBottom: 18 }}>
    <div className="small" style={{ marginBottom: 6, color: 'var(--fg2)' }}>{label}</div>
    {children}
    {hint && (
      <div className="tiny" style={{ marginTop: 4, color: hintColor || 'var(--fg2)' }}>
        {hint}
      </div>
    )}
  </div>
);

const Stat = ({ k, v }) => (
  <div>
    <div className="tiny" style={{ textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--fg2)' }}>
      {k}
    </div>
    <div className="mono" style={{ fontSize: 18, marginTop: 2 }}>{v}</div>
  </div>
);

const inputStyle = () => ({
  width: '100%',
  padding: 12,
  fontSize: 15,
  background: 'var(--bg-base)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 10,
  color: 'var(--fg1)',
});

export { SwapOrca };
