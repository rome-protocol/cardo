'use client';
// Perps — Cardo's first-class perpetual-futures surface. Jupiter Perps
// (Solana mainnet, request-fulfillment): the user signs ONE tx creating a
// PositionRequest; Jupiter keepers fill it at oracle price seconds later.
// Solana-wallet lane (Phantom/Solflare), NOT the EVM/Rome-CPI dapp lane —
// no perp venue exists on the devnet substrate, so this is where perps
// actually execute (moved out of the AI Orchestrator to its own home).
//
// Flow: build (server sims) → sign (Solana wallet) → relay. The Cardo fee
// rides the same tx and only lands if the request does (Solana atomicity).

import React, { useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { Transaction, VersionedTransaction } from '@solana/web3.js';
import s from '../../components/design/actsee.module.css';
import { fmtUSD, fmtNum } from '../../components/primitives';

const MARKETS = [
  { sym: 'SOL-PERP', base: 'SOL' as const },
  { sym: 'ETH-PERP', base: 'ETH' as const },
  { sym: 'BTC-PERP', base: 'BTC' as const },
];
const LEV_PILLS = [2, 5, 10, 20];

type Phase = 'idle' | 'building' | 'signing' | 'relaying' | 'confirmed' | 'failed';

type BuildResp = {
  tx: { kind: 'legacy' | 'v0'; b64: string };
  simUnitsConsumed?: number;
  fee?: { bps: number; lamports: number; treasury: string };
  perp?: {
    market: string; side: string; action: string;
    sizeUsd: number; collateralUsd: number; leverage: number; markUsd: number;
  };
  error?: string;
  simLogs?: string[];
};
type RelayResp = { status: string; txSig?: string; txUrl?: string; error?: string };

export default function PerpsClient() {
  const { publicKey, signTransaction } = useWallet();
  const { setVisible } = useWalletModal();

  const [marketIdx, setMarketIdx] = useState(0);
  const [side, setSide] = useState<'long' | 'short'>('long');
  const [action, setAction] = useState<'open' | 'close'>('open');
  const [sizeUsd, setSizeUsd] = useState('25');
  const [leverage, setLeverage] = useState(5);
  const [showPicker, setShowPicker] = useState(false);

  const [phase, setPhase] = useState<Phase>('idle');
  const [built, setBuilt] = useState<BuildResp | null>(null);
  const [result, setResult] = useState<RelayResp | null>(null);
  const [error, setError] = useState<string | null>(null);

  const market = MARKETS[marketIdx];
  const size = parseFloat(sizeUsd) || 0;
  const collateralEst = action === 'open' && leverage > 0 ? size / leverage : 0;
  const connected = !!publicKey;
  const busy = phase === 'building' || phase === 'signing' || phase === 'relaying';

  const run = async () => {
    if (!connected || !signTransaction) {
      setVisible(true);
      return;
    }
    setError(null);
    setResult(null);
    setBuilt(null);
    try {
      // 1. Build + pre-flight sim (server).
      setPhase('building');
      const buildRes = await fetch('/api/perps/build', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          intent: {
            kind: 'perp',
            params: { market: market.base, side, action, sizeUsd: size, leverage },
          },
          userPubkey: publicKey.toBase58(),
        }),
      });
      const b: BuildResp = await buildRes.json();
      if (!buildRes.ok) {
        throw new Error(b.error ?? `build failed (${buildRes.status})`);
      }
      setBuilt(b);

      // 2. Sign with the Solana wallet.
      setPhase('signing');
      const buf = Buffer.from(b.tx.b64, 'base64');
      const txObj = b.tx.kind === 'v0' ? VersionedTransaction.deserialize(buf) : Transaction.from(buf);
      const signed = (await signTransaction(txObj)) as Transaction | VersionedTransaction;
      const signedBuf = signed instanceof VersionedTransaction
        ? Buffer.from(signed.serialize())
        : (signed as Transaction).serialize();

      // 3. Relay (sendRawTransaction + confirm).
      setPhase('relaying');
      const relayRes = await fetch('/api/orchestrate/relay', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tx: { kind: b.tx.kind, b64: signedBuf.toString('base64') } }),
      });
      const relayed: RelayResp = await relayRes.json();
      if (relayed.status === 'Failed' || (!relayRes.ok && relayed.status !== 'Confirmed')) {
        throw new Error(relayed.error ?? `relay failed (${relayRes.status})`);
      }
      setResult(relayed);
      setPhase('confirmed');
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      // Cancel-aware: a wallet rejection isn't a failure.
      if (/reject|denied|cancel/i.test(msg)) {
        setError('Transaction cancelled.');
      } else {
        setError(msg);
      }
      setPhase('failed');
    }
  };

  const mark = built?.perp?.markUsd;
  const collateral = built?.perp?.collateralUsd ?? collateralEst;
  const liq = mark
    ? side === 'long'
      ? mark * (1 - (1 / leverage) * 0.95)
      : mark * (1 + (1 / leverage) * 0.95)
    : undefined;

  const ctaLabel = !connected
    ? 'Connect Solana wallet'
    : busy
      ? phase === 'building' ? 'Simulating…' : phase === 'signing' ? 'Sign in wallet…' : 'Submitting…'
      : action === 'close'
        ? `Close ${market.base} ${side}`
        : side === 'long' ? `Long ${market.base}` : `Short ${market.base}`;
  const ctaCaption = !connected
    ? 'Phantom / Solflare · Solana mainnet'
    : action === 'open'
      ? 'one signature — Jupiter keeper fills at oracle price'
      : 'closes the entire position at market';

  return (
    <main className={s.work}>
      <div className={s.strip}>
        <div className={s.lead}>
          <span className={s.eyebrow}>Jupiter Perps · perpetual futures</span>
          <h1>
            Trade perps on Solana — <em>one signature, keeper-filled</em>.
          </h1>
        </div>
        <span className={s.routepill}>
          <span className={`${s.dot} ${s.sol}`} /> Solana · Mainnet <span className={s.ar}>→</span> Jupiter Perps
        </span>
      </div>

      <div className={s.rig}>
        {/* ── ACT: order ticket ── */}
        <form className={`${s.col} ${s.act}`} autoComplete="off" onSubmit={(e) => { e.preventDefault(); run(); }}>
          <div className={s.colhd}>
            <span className={s.sd} /> You do this
          </div>

          <div className={s.tabs}>
            <button type="button" aria-pressed={action === 'open'} onClick={() => setAction('open')} disabled={busy}>Open</button>
            <button type="button" aria-pressed={action === 'close'} onClick={() => setAction('close')} disabled={busy}>Close</button>
          </div>

          <div className={s.tabs} style={{ marginTop: 8 }}>
            <button type="button" aria-pressed={side === 'long'} onClick={() => setSide('long')} disabled={busy}>Long</button>
            <button type="button" aria-pressed={side === 'short'} onClick={() => setSide('short')} disabled={busy}>Short</button>
          </div>

          <div className={s.leg}>
            <div className={s.r1}>
              <label>{action === 'close' ? 'Market' : 'Position size'}</label>
              <span className={s.bal}>{action === 'close' ? 'entire position' : 'USD notional'}</span>
            </div>
            <div className={s.r2}>
              <div style={{ flex: 1, minWidth: 0 }}>
                {action === 'open' ? (
                  <>
                    <input className={s.amt} inputMode="decimal" aria-label="Size" placeholder="0.00" value={sizeUsd} onChange={(e) => setSizeUsd(e.target.value)} disabled={busy} />
                    <div className={s.usd}>≈ {fmtUSD(size)} notional</div>
                  </>
                ) : (
                  <div className={s.amt} style={{ opacity: 0.8 }}>Close {market.base} {side}</div>
                )}
              </div>
              <button type="button" className={s.tokchip} onClick={() => !busy && setShowPicker(true)}>
                <span className={`${s.ic} ${s.gen}`}>{market.base.charAt(0).toLowerCase()}</span>
                <span className={s.sym}>{market.sym}</span>
                <span className={s.car}>▾</span>
              </button>
            </div>
          </div>

          {action === 'open' && (
            <div className={s.slip}>
              <span className={s.lbl}>Leverage · {leverage}×</span>
              {LEV_PILLS.map((l) => (
                <button key={l} type="button" aria-pressed={leverage === l} onClick={() => setLeverage(l)} disabled={busy}>{l}×</button>
              ))}
            </div>
          )}

          <div className={s['cta-wrap']}>
            <button className={s.cta} type="submit" disabled={busy || (action === 'open' && size <= 0)}>
              <span>{ctaLabel}</span>
              <span className={s.sig}>{ctaCaption}</span>
            </button>
          </div>
        </form>

        {/* ── SEE: order preview + result ── */}
        <section className={`${s.col} ${s.see}`}>
          <div className={s.colhd}>
            <span className={s.sd} /> What will happen
            <span className={s.pool}>{market.sym} · Jupiter Perps</span>
          </div>
          <div className={s.body}>
            <div className={s.sigbox}>
              <div className={s.big}>1</div>
              <div>
                <div className={s.l1}>signature</div>
                <div className={s.l2}>
                  You sign one request; Jupiter <b>keepers</b> fill it at oracle price.
                </div>
              </div>
            </div>

            <div className={s.outcome}>
              <div className={`${s.ln} ${s.get}`}>
                <span className={s.k}>{action === 'close' ? 'Close' : side === 'long' ? 'Long' : 'Short'} {market.base}</span>
                <span className={s.v}>
                  {action === 'close' ? 'entire position → USDC' : `${fmtUSD(size)} @ ${leverage}×`}
                </span>
              </div>
              {mark !== undefined && (
                <div className={s.ln}>
                  <span className={s.k}>Mark <small>live</small></span>
                  <span className={s.v}>{fmtUSD(mark, { decimals: mark > 100 ? 2 : 4 })}</span>
                </div>
              )}
              {action === 'open' && (
                <div className={s.ln}>
                  <span className={s.k}>Collateral <small>USDC</small></span>
                  <span className={s.v}>{fmtUSD(collateral)}</span>
                </div>
              )}
              {liq !== undefined && action === 'open' && (
                <div className={s.ln}>
                  <span className={s.k}>Est. liquidation</span>
                  <span className={s.v}>{fmtUSD(liq, { decimals: liq > 100 ? 2 : 4 })}</span>
                </div>
              )}
              {built?.simUnitsConsumed !== undefined && (
                <div className={s.ln}>
                  <span className={s.k}>Pre-flight sim</span>
                  <span className={s.v}>✓ {fmtNum(built.simUnitsConsumed, 0)} CU</span>
                </div>
              )}
              {built?.fee && built.fee.lamports > 0 && (
                <div className={s.ln}>
                  <span className={s.k}>Cardo fee <small>{(built.fee.bps / 100).toFixed(2)}%</small></span>
                  <span className={s.v}>{fmtNum(built.fee.lamports / 1e9, 5)} SOL</span>
                </div>
              )}
              <div className={s.note}>
                Perps run on <b>Jupiter Perps</b> (Solana mainnet) with your Solana wallet — request-fulfillment,
                so you sign once and a keeper executes at the oracle price. The Cardo fee rides the same
                transaction and only lands if the request does.
              </div>
            </div>
          </div>
          <div className={s.status}>
            {phase === 'confirmed' && result?.txSig ? (
              <span className={s.ok}>
                ✓ Request submitted ·{' '}
                <a href={result.txUrl ?? `https://solscan.io/tx/${result.txSig}`} target="_blank" rel="noreferrer">
                  {result.txSig.slice(0, 6)}…{result.txSig.slice(-4)} ↗
                </a>
              </span>
            ) : phase === 'failed' && error ? (
              <span className={s.bad}>{error}</span>
            ) : busy ? (
              phase === 'building' ? 'Simulating your position…' : phase === 'signing' ? 'Approve in your wallet…' : 'Submitting to Solana…'
            ) : connected ? (
              'Ready — this is exactly what your wallet will sign.'
            ) : (
              'Connect your Solana wallet to trade.'
            )}
          </div>
        </section>
      </div>

      {showPicker && (
        <div className={s.scrim} onClick={() => setShowPicker(false)}>
          <div className={s.picker} onClick={(e) => e.stopPropagation()}>
            <span className={s.eyebrow}>Select market</span>
            <div className={s.list} style={{ marginTop: 14 }}>
              {MARKETS.map((m, i) => (
                <button key={m.sym} type="button" className={s.row} disabled={i === marketIdx} onClick={() => { setMarketIdx(i); setShowPicker(false); }}>
                  <span className={`${s.ic} ${s.gen}`}>{m.base.charAt(0).toLowerCase()}</span>
                  <div style={{ minWidth: 0 }}>
                    <div className={s.sym}>{m.sym}</div>
                    <div className={s.nm}>{m.base} · long or short</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
