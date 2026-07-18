'use client';
// SwapPhoenix screen — act|see redesign. Swap WSOL ↔ USDC through the
// Phoenix CLOB (IOC market order) on Solana, from one EVM wallet.
//
// Phoenix is an order book, not an AMM: inputs are converted to *lots*
// (base lot size / quote lot size from the market header), and fills come
// from resting limit orders. There is no constant-product formula; we use
// the seeded resting-order price as an indicative quote. The slippage
// guard is expressed as minOutputLots inside the OrderPacket.
//
// Lot-math is preserved verbatim from the pre-redesign screen.

import React, { useEffect, useMemo, useState } from 'react';
import { fmtNum } from '../primitives';
import { Ledger } from '../design/Ledger';
import { TxHash } from '../design/Inline';
import { signaturePlan } from '../../lib/signature-plan';
import s from '../design/actsee.module.css';

const SLIPPAGE_BPS = 200; // 2 %
const SEED_ASK_TICKS = 1100n; // bootstrap ask — indicative anchor only
const SEED_BID_TICKS = 900n;

export function SwapPhoenix({
  wallet,
  onConnect,
  market,
  marketState,
  ataBalancesByMint = {},
  onSwap,
  swapState,
}) {
  const [inputIsBase, setInputIsBase] = useState(true); // true → sell base (WSOL→USDC)
  const [amount, setAmount] = useState('');

  const sym0 = market?.baseDecimals === 9 ? 'WSOL' : 'BASE';
  const sym1 = market?.quoteDecimals === 6 ? 'USDC' : 'QUOTE';

  const inSym = inputIsBase ? sym0 : sym1;
  const outSym = inputIsBase ? sym1 : sym0;
  const inMint = inputIsBase ? market?.baseMint : market?.quoteMint;
  const outMint = inputIsBase ? market?.quoteMint : market?.baseMint;
  const inDecimals = inputIsBase ? market?.baseDecimals : market?.quoteDecimals;
  const outDecimals = inputIsBase ? market?.quoteDecimals : market?.baseDecimals;
  const inBalance = inMint ? (ataBalancesByMint[inMint] ?? 0) : 0;
  const outBalance = outMint ? (ataBalancesByMint[outMint] ?? 0) : 0;

  const amt = parseFloat(amount) || 0;

  const header = marketState?.header ?? null;
  const baseAtoms = marketState?.baseVaultAtoms ?? null;
  const quoteAtoms = marketState?.quoteVaultAtoms ?? null;

  const noLiquidity =
    baseAtoms != null && quoteAtoms != null && (baseAtoms <= 0n || quoteAtoms <= 0n);
  const inactiveStatus = header && header.status !== 1n; // 1 = Active

  // ── Indicative-quote derivation ──────────────────────────────────────────
  // Phoenix prices in TICKS (1 tick = tickSizeInQuoteAtomsPerBaseUnit).
  // With Cardo's seeded params: 100,000 quote atoms (0.10 USDC) per 1 SOL per tick.
  //
  // base→quote sell (ASK): hits resting BID @ SEED_BID_TICKS (~$90/SOL)
  // quote→base buy (BID):  hits resting ASK @ SEED_ASK_TICKS (~$110/SOL)
  const quote = useMemo(() => {
    if (!header || amt <= 0 || inDecimals == null || outDecimals == null) return null;

    const inputAtoms = BigInt(Math.floor(amt * 10 ** inDecimals));
    if (inputAtoms <= 0n) return null;

    const baseLotSize = header.baseLotSize;
    const quoteLotSize = header.quoteLotSize;
    const tickInQuoteAtomsPerBaseUnit = header.tickSizeInQuoteAtomsPerBaseUnit;
    const baseAtomsPerBaseUnit =
      10n ** BigInt(header.baseDecimals) * BigInt(header.rawBaseUnitsPerBaseUnit || 1);

    if (inputIsBase) {
      // Selling WSOL → receiving USDC. Hits resting BID @ SEED_BID_TICKS.
      const numBaseLots = inputAtoms / baseLotSize;
      if (numBaseLots <= 0n) return null;
      const priceQuoteAtomsPerBaseUnit = SEED_BID_TICKS * tickInQuoteAtomsPerBaseUnit;
      const quoteAtomsOut =
        (numBaseLots * baseLotSize * priceQuoteAtomsPerBaseUnit) / baseAtomsPerBaseUnit;
      const numQuoteLotsOut = quoteAtomsOut / quoteLotSize;
      return {
        inputLots: numBaseLots,
        outputLots: numQuoteLotsOut,
        humanOut: Number(quoteAtomsOut) / 10 ** header.quoteDecimals,
        priceLabel: `${Number(priceQuoteAtomsPerBaseUnit) / 10 ** header.quoteDecimals} ${sym1}/${sym0}`,
      };
    } else {
      // Buying WSOL with USDC. Hits resting ASK @ SEED_ASK_TICKS.
      const numQuoteLots = inputAtoms / quoteLotSize;
      if (numQuoteLots <= 0n) return null;
      const priceQuoteAtomsPerBaseUnit = SEED_ASK_TICKS * tickInQuoteAtomsPerBaseUnit;
      const baseAtomsOut =
        (numQuoteLots * quoteLotSize * baseAtomsPerBaseUnit) / priceQuoteAtomsPerBaseUnit;
      const numBaseLotsOut = baseAtomsOut / baseLotSize;
      return {
        inputLots: numQuoteLots,
        outputLots: numBaseLotsOut,
        humanOut: Number(baseAtomsOut) / 10 ** header.baseDecimals,
        priceLabel: `${Number(priceQuoteAtomsPerBaseUnit) / 10 ** header.quoteDecimals} ${sym1}/${sym0}`,
      };
    }
  }, [header, amt, inDecimals, outDecimals, inputIsBase, sym0, sym1]);

  // Reset amount when direction flips (lot sizes differ per side)
  useEffect(() => {
    setAmount('');
  }, [inputIsBase]);

  // ── Signature ledger ─────────────────────────────────────────────────────
  // outAtaExists=undefined → optimistic (no probe needed for Phoenix — the
  // ATA must already exist for the user to have balance). Always 1 sig.
  const rawSteps = signaturePlan('swap', { outAtaExists: undefined });
  const steps = rawSteps.map((st) =>
    st.id === 'swap'
      ? { ...st, label: 'Swap on Phoenix', detail: 'CPI → Phoenix IOC market order' }
      : st,
  );
  const count = steps.length;

  // ── CTA state ────────────────────────────────────────────────────────────
  const phase = swapState?.phase ?? 'idle';
  const isWorking = phase === 'signing' || phase === 'confirming';
  const insufficient = amt > 0 && amt > inBalance;

  const submitDisabled =
    !wallet?.connected ||
    !market ||
    !header ||
    !!inactiveStatus ||
    !!noLiquidity ||
    amt <= 0 ||
    insufficient ||
    isWorking ||
    !quote ||
    quote.outputLots <= 0n;

  let ctaLabel = `Swap ${inSym} → ${outSym}`;
  let ctaCaption = '1 signature · settles atomically on Solana';
  let ctaDisabled = submitDisabled;
  let ctaOnClick;

  if (!wallet?.connected) {
    ctaLabel = 'Connect wallet';
    ctaCaption = 'one wallet — no bridge, no Phantom';
    ctaDisabled = false;
    ctaOnClick = onConnect;
  } else if (!market || !header) {
    ctaLabel = 'Loading market…';
    ctaDisabled = true;
  } else if (inactiveStatus) {
    ctaLabel = 'Market inactive';
    ctaDisabled = true;
  } else if (noLiquidity) {
    ctaLabel = 'No liquidity in book';
    ctaDisabled = true;
  } else if (isWorking) {
    ctaLabel = phase === 'signing' ? 'Awaiting signature…' : 'Confirming on Solana…';
    ctaDisabled = true;
  } else if (insufficient) {
    ctaLabel = `Insufficient ${inSym}`;
    ctaDisabled = true;
  } else {
    ctaOnClick = () => {
      if (!quote) return;
      const slippageMul = BigInt(10_000 - SLIPPAGE_BPS);
      const minOutLots = (quote.outputLots * slippageMul) / 10_000n;
      onSwap?.({ inputIsBase, inputLots: quote.inputLots, minOutputLots: minOutLots });
    };
  }

  // ── Status node ──────────────────────────────────────────────────────────
  let statusNode = <>Preview · this is exactly what your wallet will sign</>;
  if (phase === 'signing') statusNode = <>Confirm in MetaMask…</>;
  else if (phase === 'confirming') statusNode = <>Settling on Solana…</>;
  else if (phase === 'success')
    statusNode = (
      <>
        <span className={s.ok}>✓ Settled on Phoenix</span>
        {swapState.hash ? (
          <>
            {' '}
            · <TxHash hash={swapState.hash} />
          </>
        ) : null}
      </>
    );
  else if (phase === 'failed')
    statusNode = <span className={s.bad}>Reverted · try again</span>;

  // ── Outcome helpers ──────────────────────────────────────────────────────
  const minOut = quote
    ? quote.humanOut * (1 - SLIPPAGE_BPS / 10_000)
    : 0;

  return (
    <main className={s.work}>
      <div className={s.strip}>
        <div className={s.lead}>
          <span className={s.eyebrow}>Phoenix · order-book swap</span>
          <h1>
            Swap on Phoenix from your EVM wallet — <em>one wallet, no bridge</em>.
          </h1>
        </div>
        <span className={s.routepill}>
          <span className={`${s.dot} ${s.evm}`} /> EVM · Rome <span className={s.ar}>→</span>{' '}
          Phoenix <span className={`${s.dot} ${s.sol}`} />
        </span>
      </div>

      <div className={s.rig}>
        {/* ── ACT ── */}
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

          {/* Direction toggle */}
          <div className={s.slip} style={{ borderTop: 'none', paddingBottom: 0 }}>
            <span className={s.lbl}>Direction</span>
            <button
              type="button"
              aria-pressed={inputIsBase}
              onClick={() => setInputIsBase(true)}
            >
              {sym0} → {sym1}
            </button>
            <button
              type="button"
              aria-pressed={!inputIsBase}
              onClick={() => setInputIsBase(false)}
            >
              {sym1} → {sym0}
            </button>
          </div>

          {/* Input leg */}
          <div className={s.leg}>
            <div className={s.r1}>
              <label>You pay</label>
              <span className={s.bal}>
                balance <b>{fmtNum(inBalance, 4)}</b> {inSym}
              </span>
            </div>
            <div className={s.r2}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <input
                  className={s.amt}
                  inputMode="decimal"
                  aria-label="Pay amount"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
                {insufficient && (
                  <div className={s.usd} style={{ color: 'var(--bad)' }}>
                    exceeds balance
                  </div>
                )}
              </div>
              <div className={s.tokchip}>
                <span className={`${s.ic} ${inputIsBase ? s.sol : s.usdc}`}>
                  {inSym.charAt(1).toLowerCase()}
                </span>
                <span className={s.sym}>{inSym}</span>
              </div>
            </div>
            <div className={s.pct}>
              {[25, 50, 100].map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() =>
                    setAmount(
                      ((inBalance * p) / 100).toFixed(inDecimals ?? 6).replace(/\.?0+$/, ''),
                    )
                  }
                >
                  {p === 100 ? 'Max' : `${p}%`}
                </button>
              ))}
            </div>
          </div>

          <div className={s.flipwrap}>
            <button
              type="button"
              className={s.flip}
              aria-label="Flip direction"
              onClick={() => setInputIsBase((v) => !v)}
            >
              ⇅
            </button>
          </div>

          {/* Output leg */}
          <div className={s.leg}>
            <div className={s.r1}>
              <label>You receive (indicative)</label>
              <span className={s.bal}>
                balance <b>{fmtNum(outBalance, 4)}</b> {outSym}
              </span>
            </div>
            <div className={s.r2}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className={`${s.amt} ${s.out}`}>
                  {quote && quote.humanOut > 0 ? fmtNum(quote.humanOut, 6) : '0.00'}
                </div>
                {quote && (
                  <div className={s.usd}>resting price {quote.priceLabel}</div>
                )}
              </div>
              <div className={s.tokchip}>
                <span className={`${s.ic} ${inputIsBase ? s.usdc : s.sol}`}>
                  {outSym.charAt(1).toLowerCase()}
                </span>
                <span className={s.sym}>{outSym}</span>
              </div>
            </div>
          </div>

          {/* Market info strip */}
          <div className={s.slip}>
            <span className={s.lbl}>Slippage guard</span>
            <span
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 11,
                color: 'var(--muted)',
                border: '1px solid var(--line)',
                borderRadius: 'var(--r)',
                padding: '4px 9px',
              }}
            >
              {SLIPPAGE_BPS / 100}% hard floor
            </span>
          </div>

          <div className={s['cta-wrap']}>
            <button
              className={s.cta}
              type="submit"
              disabled={ctaDisabled}
            >
              <span>{ctaLabel}</span>
              <span className={s.sig}>{ctaCaption}</span>
            </button>
          </div>
        </form>

        {/* ── SEE ── */}
        <section className={`${s.col} ${s.see}`}>
          <div className={s.colhd}>
            <span className={s.sd} /> What will happen
            <span className={s.pool}>Phoenix CLOB · IOC</span>
          </div>
          <div className={s.body}>
            <Ledger
              steps={steps}
              count={count}
              loading={false}
              sub={
                <>
                  One wallet — <b>no bridge, no Phantom, no second account</b>. Matches
                  against resting limit orders on the Phoenix FIFO book.
                </>
              }
            />
            <div className={s.outcome}>
              <div className={`${s.ln} ${s.get}`}>
                <span className={s.k}>You receive at least</span>
                <span className={s.v}>
                  {quote && minOut > 0 ? fmtNum(minOut, 6) : '—'} {outSym}
                </span>
              </div>
              {quote && (
                <div className={s.ln}>
                  <span className={s.k}>Resting price</span>
                  <span className={s.v}>{quote.priceLabel}</span>
                </div>
              )}
              <div className={s.ln}>
                <span className={s.k}>
                  Slippage guard <small>{SLIPPAGE_BPS / 100}%</small>
                </span>
                <span className={s.v}>minOutputLots enforced on-chain</span>
              </div>
              <div className={s.ln}>
                <span className={s.k}>Order type</span>
                <span className={s.v}>ImmediateOrCancel (IOC)</span>
              </div>
              {inactiveStatus && (
                <div className={s.ln}>
                  <span className={s.k} style={{ color: 'var(--bad)' }}>Market status</span>
                  <span className={s.v} style={{ color: 'var(--bad)' }}>Inactive</span>
                </div>
              )}
              {noLiquidity && !inactiveStatus && (
                <div className={s.ln}>
                  <span className={s.k} style={{ color: 'var(--bad)' }}>Liquidity</span>
                  <span className={s.v} style={{ color: 'var(--bad)' }}>Order book empty</span>
                </div>
              )}
              <div className={s.note}>
                Phoenix is a real CLOB: fills come from resting limit orders at the
                seeded price. Any unfilled quantity is <b>cancelled automatically</b> by
                the IOC order type — your slippage floor is enforced on-chain.
              </div>
            </div>
          </div>
          <div className={s.status}>{statusNode}</div>
        </section>
      </div>
    </main>
  );
}
