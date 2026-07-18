'use client';
// Bridge screen — act|see redesign. BIDIRECTIONAL via a direction toggle:
//   IN  (Sepolia → Rome): USDC→CCTP (2 sigs on Sepolia), ETH→Wormhole (1 sig)
//   OUT (Rome → Sepolia): USDC→CCTP (1 sig on Rome),     ETH→Wormhole (2 sigs)
// Protocol is chosen by the asset, never asked. Inbound is fire-and-forget (the
// relayer credits Rome). Outbound is USER-PAID: burn on Rome, then redeem on
// Sepolia yourself once attested. Settlement is the backend's job — see the page.

import React, { useState, useEffect } from 'react';
import { fmtNum } from '../primitives';
import { Ledger } from '../design/Ledger';
import { TxError, TxHash } from '../design/Inline';
import s from '../design/actsee.module.css';

function iconClass(sym) {
  const u = (sym || '').toUpperCase();
  if (u.includes('USD')) return s.usdc;
  if (u.includes('SOL')) return s.sol;
  if (u.includes('ETH')) return s.eth;
  return s.gen;
}
function humanPhase(p) {
  switch (p) {
    case 'registered': return 'registered';
    case 'awaiting-attestation': return 'awaiting attestation (~15-20 min)';
    case 'awaiting-vaa': return 'awaiting Wormhole VAA (~15-20 min)';
    case 'submitting': return 'crediting…';
    case 'complete': return 'complete ✓';
    case 'failed': return 'failed';
    case 'registration-failed': return 'tracking unavailable — funds safe, tx recoverable by hash';
    default: return String(p);
  }
}
function humanOutcome(o) {
  switch (o) {
    case 'all-gas': return 'credited as native gas';
    case 'wrapper-only': return 'delivered as wrapped token';
    case 'settle-skipped': return 'delivered as wrapper (settle skipped)';
    default: return String(o);
  }
}
const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test((a || '').trim());

const Bridge = ({
  wallet,
  onConnect,
  assets = [],
  sourceName = 'Sepolia',
  sourceExplorer = 'https://sepolia.etherscan.io',
  romeExplorer = '',
  nativeSymbol = 'USDC',
  configured = true,
  flow = { phase: 'idle', stepIndex: 0, stepCount: 0 },
  onBridge,
}) => {
  const [direction, setDirection] = useState('in'); // 'in' | 'out'
  const [assetId, setAssetId] = useState(assets[0]?.id ?? 'usdc');
  const [amount, setAmount] = useState('');
  const [recipient, setRecipient] = useState('');
  const [showPicker, setShowPicker] = useState(false);

  useEffect(() => {
    if (assets.length && !assets.find((x) => x.id === assetId)) setAssetId(assets[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assets.map((x) => x.id).join(',')]);
  // Default the outbound recipient to the connected wallet (their Sepolia addr).
  useEffect(() => {
    if (direction === 'out' && !recipient && wallet?.address) setRecipient(wallet.address);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [direction, wallet?.address]);

  const asset = assets.find((x) => x.id === assetId) ?? assets[0];
  const sym = asset?.symbol ?? 'USDC';
  const protocol = asset?.protocol ?? 'cctp';
  const a = parseFloat(amount) || 0;
  const out = direction === 'out';

  const sigCount = protocol === 'cctp' ? (out ? 1 : 2) : out ? 2 : 1;
  const steps = (() => {
    if (!out && protocol === 'cctp') {
      return [
        { id: 'approve', label: `Approve ${sym} on ${sourceName}`, detail: 'erc20 approve', atomic: false, setup: true },
        { id: 'burn', label: `Burn ${sym} · CCTP`, detail: 'depositForBurn', atomic: false },
      ];
    }
    if (!out && protocol === 'wormhole') {
      return [{ id: 'lock', label: `Lock ${sym} via Wormhole`, detail: 'wrapAndTransferETH', atomic: false }];
    }
    if (out && protocol === 'cctp') {
      return [{ id: 'burn', label: `Burn ${sym} on Rome · CCTP`, detail: 'burnUSDC', atomic: false }];
    }
    return [
      { id: 'approve', label: `Approve w${sym} on Rome`, detail: 'approveBurnETH', atomic: false, setup: true },
      { id: 'burn', label: `Burn w${sym} · Wormhole`, detail: 'burnETH', atomic: false },
    ];
  })();

  const routeFrom = out ? 'Rome' : sourceName;
  const routeTo = out ? sourceName : 'Rome';
  const signOn = out ? 'Rome' : sourceName;
  const recipientValid = !out || isAddr(recipient);
  const busy = ['awaiting', 'confirming', 'submitting'].includes(flow.phase);
  const receiveLabel = out
    ? `${sym} on ${sourceName}`
    : asset?.settlesAsGas
      ? `${nativeSymbol} (native gas)`
      : `w${sym}`;

  let ctaLabel = `Bridge — sign ${sigCount} transaction${sigCount > 1 ? 's' : ''}`;
  let ctaCaption = `${routeFrom} → ${routeTo} · ${protocol === 'cctp' ? 'CCTP' : 'Wormhole'}`;
  let ctaDisabled = false;
  let ctaOnClick;
  if (!wallet.connected) {
    ctaLabel = 'Connect wallet';
    ctaCaption = 'connect to bridge';
    ctaOnClick = onConnect;
  } else if (!configured) {
    ctaLabel = 'Bridge unavailable on this chain';
    ctaDisabled = true;
  } else if (busy) {
    ctaDisabled = true;
    ctaLabel =
      flow.phase === 'awaiting'
        ? `Sign ${Math.min(flow.stepIndex + 1, sigCount)} of ${sigCount} in your wallet…`
        : flow.phase === 'confirming'
          ? `Confirming on ${signOn}…`
          : 'Submitting…';
  } else {
    ctaDisabled = a <= 0 || !recipientValid;
    ctaLabel =
      a <= 0
        ? 'Enter an amount'
        : out && !recipientValid
          ? `Enter a ${sourceName} recipient`
          : `Bridge — sign ${sigCount} transaction${sigCount > 1 ? 's' : ''}`;
    ctaOnClick = () => onBridge && onBridge({ direction, assetId, amount: String(a), recipient: recipient.trim() });
  }

  let statusNode = <>Preview · this is exactly what your wallet will sign</>;
  if (flow.phase === 'submitted') {
    statusNode = (
      <>
        <span className={s.ok}>✓ {flow.direction === 'out' ? 'Burned on Rome' : `Submitted on ${sourceName}`}</span> ·{' '}
        {flow.statusPhase
          ? humanPhase(flow.statusPhase)
          : flow.direction === 'out'
            ? `redeem on ${sourceName} once attested`
            : 'settling on Rome…'}
        {flow.statusOutcome ? <> · {humanOutcome(flow.statusOutcome)}</> : null}
        {flow.txHash ? (
          <>
            {' '}·{' '}
            <TxHash hash={flow.txHash} label="burn tx" href={flow.direction === 'out' ? (romeExplorer ? `${romeExplorer}/tx/${flow.txHash}` : undefined) : `${sourceExplorer}/tx/${flow.txHash}`} />
          </>
        ) : null}
      </>
    );
  } else if (flow.phase === 'failed') {
    statusNode = <TxError error={flow.error} />;
  } else if (busy) {
    statusNode = <>Confirm in your wallet…</>;
  }

  return (
    <>
      <main className={s.work}>
        <div className={s.strip}>
          <div className={s.lead}>
            <span className={s.eyebrow}>{out ? `Outbound bridge · Rome → ${sourceName}` : `Inbound bridge · ${sourceName} → Rome`}</span>
            <h1>
              {out ? (
                <>Send assets from Rome to {sourceName} — <em>one wallet</em>.</>
              ) : (
                <>Bring assets from {sourceName} into Rome — <em>one wallet</em>.</>
              )}
            </h1>
          </div>
          <span className={s.routepill}>
            <span className={`${s.dot} ${out ? s.sol : s.evm}`} /> {routeFrom} <span className={s.ar}>→</span> {routeTo}{' '}
            <span className={`${s.dot} ${out ? s.evm : s.sol}`} />
          </span>
        </div>

        <div className={s.rig}>
          <form className={`${s.col} ${s.act}`} autoComplete="off" onSubmit={(e) => { e.preventDefault(); if (ctaOnClick) ctaOnClick(); }}>
            <div className={s.colhd}>
              <span className={s.sd} /> You do this
            </div>

            <div className={s.tabs}>
              <button type="button" aria-pressed={!out} onClick={() => setDirection('in')}>Bridge in</button>
              <button type="button" aria-pressed={out} onClick={() => setDirection('out')}>Bridge out</button>
            </div>

            <div className={s.leg}>
              <div className={s.r1}>
                <label>You bridge</label>
                <span className={s.bal}>from {routeFrom}</span>
              </div>
              <div className={s.r2}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <input className={s.amt} inputMode="decimal" aria-label="Amount" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
                  <div className={s.usd}>{out ? `w${sym} on Rome` : `real ${sym} on ${sourceName}`}</div>
                </div>
                <button type="button" className={s.tokchip} onClick={() => assets.length > 1 && setShowPicker(true)}>
                  <span className={`${s.ic} ${iconClass(sym)}`}>{sym.charAt(0).toLowerCase()}</span>
                  <span className={s.sym}>{sym}</span>
                  {assets.length > 1 && <span className={s.car}>▾</span>}
                </button>
              </div>
            </div>

            {out && (
              <div className={s.field}>
                <label htmlFor="bridge-recip">Recipient · {sourceName} (Ethereum) address</label>
                <input id="bridge-recip" className={s.txt} placeholder="0x… (defaults to your wallet)" value={recipient} onChange={(e) => setRecipient(e.target.value)} />
              </div>
            )}

            <div className={s['cta-wrap']}>
              <button className={s.cta} type="submit" disabled={ctaDisabled}>
                <span>{ctaLabel}</span>
                <span className={s.sig}>{ctaCaption}</span>
              </button>
            </div>
          </form>

          <section className={`${s.col} ${s.see}`}>
            <div className={s.colhd}>
              <span className={s.sd} /> What will happen
              <span className={s.pool}>{protocol === 'cctp' ? 'Circle CCTP' : 'Wormhole'}</span>
            </div>
            <div className={s.body}>
              <Ledger
                steps={steps}
                count={steps.length}
                loading={false}
                sub={
                  out ? (
                    <>You sign the burn on Rome; then <b>redeem on {sourceName}</b> yourself once attested (user-paid).</>
                  ) : (
                    <>You sign on {sourceName}; the relayer then attests + credits Rome — <b>no further signature</b>.</>
                  )
                }
              />
              <div className={s.outcome}>
                <div className={`${s.ln} ${s.get}`}>
                  <span className={s.k}>You receive on {routeTo}</span>
                  <span className={s.v}>{fmtNum(a, 6)} {receiveLabel}</span>
                </div>
                <div className={s.ln}>
                  <span className={s.k}>Protocol</span>
                  <span className={s.v}>{protocol === 'cctp' ? 'CCTP · Circle' : 'Wormhole'}</span>
                </div>
                <div className={s.note}>
                  {out ? (
                    <>Burn is on Rome; {sym} becomes claimable on {sourceName} after attestation (~15-20 min). Redeem is <b>user-paid</b> via the {protocol === 'cctp' ? 'Circle' : 'Wormhole'} portal.</>
                  ) : asset?.settlesAsGas ? (
                    <>{sym} is this chain&apos;s gas token, so the relayer settles it to <b>native gas</b> automatically.</>
                  ) : (
                    <>{sym} lands as <b>w{sym}</b> (its Rome wrapper). Attestation takes ~15-20 min.</>
                  )}
                </div>
              </div>
            </div>
            <div className={s.status}>{statusNode}</div>
          </section>
        </div>
      </main>

      {showPicker && (
        <div className={s.scrim} onClick={() => setShowPicker(false)}>
          <div className={s.picker} onClick={(e) => e.stopPropagation()}>
            <span className={s.eyebrow}>Select asset</span>
            <div className={s.list} style={{ marginTop: 14 }}>
              {assets.map((t) => (
                <button key={t.id} type="button" className={s.row} disabled={t.id === assetId} onClick={() => { setAssetId(t.id); setShowPicker(false); }}>
                  <span className={`${s.ic} ${iconClass(t.symbol)}`}>{t.symbol.charAt(0).toLowerCase()}</span>
                  <div style={{ minWidth: 0 }}>
                    <div className={s.sym}>{t.symbol}</div>
                    <div className={s.nm}>{t.protocol === 'cctp' ? 'CCTP' : 'Wormhole'} · {t.name}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export { Bridge };
