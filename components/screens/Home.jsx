'use client';
// Home / Portfolio — act|see redesign. The dashboard: your live Solana holdings
// (real balances, no mock numbers), the EVM⇄Solana "two worlds, one wallet"
// explainer, and quick actions into the flows. No signature ledger — this is a
// read surface, not an action. Holdings come from useHoldings (lifted balance
// plumbing) via the page wrapper.

import React from 'react';
import { fmtUSD, fmtNum } from '../primitives';
import { GasWrapCard } from '../GasWrapCard';
import s from '../design/actsee.module.css';

function iconClass(sym) {
  const u = (sym || '').toUpperCase();
  if (u.includes('USD')) return s.usdc;
  if (u.includes('SOL')) return s.sol;
  if (u.includes('ETH')) return s.eth;
  return s.gen;
}

const Home = ({ wallet, onConnect, onNav, holdings = [], totalUsd = 0, loading = false }) => {
  const held = holdings.filter((h) => h.balance > 0);
  const wusdc = holdings.find((h) => /^wusdc$/i.test(h.symbol))?.balance ?? 0;

  return (
    <main className={s.work}>
      <div className={s.strip}>
        <div className={s.lead}>
          <span className={s.eyebrow}>Your portfolio · Rome</span>
          <h1>
            Your Solana assets, <em>one EVM wallet</em>.
          </h1>
        </div>
        <span className={s.routepill}>
          <span className={`${s.dot} ${s.evm}`} /> EVM · Rome <span className={s.ar}>⇄</span> Solana{' '}
          <span className={`${s.dot} ${s.sol}`} />
        </span>
      </div>

      <div className={s.pf}>
        {/* total value */}
        <div className={s.hcard} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div className={s.eyebrow}>Total value · live</div>
            <div className={s.totalval} style={{ marginTop: 8 }}>
              {wallet.connected ? fmtUSD(totalUsd) : '—'}
            </div>
          </div>
          {!wallet.connected && (
            <button type="button" className={s.btn} onClick={onConnect}>
              Connect wallet
            </button>
          )}
        </div>

        {/* holdings */}
        {!wallet.connected ? (
          <div className={`${s.pfpanel} ${s.empty}`}>
            Connect a wallet to see your wrapped-SPL holdings on Rome.
          </div>
        ) : loading && held.length === 0 ? (
          <div className={`${s.pfpanel} ${s.empty}`}>Reading your balances…</div>
        ) : held.length === 0 ? (
          <div className={`${s.pfpanel} ${s.empty}`}>
            No wrapped-SPL balances yet. Bridge in, or swap from gas to get started.
          </div>
        ) : (
          <div className={s.holdings}>
            {held.map((h) => (
              <div key={h.symbol} className={s.hcard}>
                <div className={s.top}>
                  <span className={`${s.ic} ${iconClass(h.symbol)}`}>{h.symbol.charAt(0).toLowerCase()}</span>
                  <span className={s.sym}>{h.symbol}</span>
                  <span className={s.kind}>SPL</span>
                </div>
                <div className={s.amt2}>{fmtNum(h.balance)}</div>
                <div className={s.sub}>{h.price > 0 ? fmtUSD(h.usd) : '—'}</div>
              </div>
            ))}
          </div>
        )}

        {wallet.connected && (
          <GasWrapCard userAddress={wallet.address} wrapperBalance={wusdc} />
        )}

        {/* lower: how it works + quick actions */}
        <div className={s.lower}>
          <div className={s.pfpanel}>
            <h3>The road · how your balances work</h3>
            <div className={s.worlds}>
              <div className={`${s.w} ${s.evm}`}>
                <div className={s.t}>EVM side · Rome</div>
                <div className={s.d}>
                  Your wrapped tokens live in your Rome account. You sign here, in MetaMask — one
                  wallet, no bridge.
                </div>
              </div>
              <div className={s.sep} />
              <div className={`${s.w} ${s.sol}`}>
                <div className={s.t}>Solana side</div>
                <div className={s.d}>
                  Every balance is a real SPL token on Solana. When you act, it executes there and
                  settles back.
                </div>
              </div>
            </div>
          </div>

          <div className={s.pfpanel}>
            <h3>Do something with it</h3>
            <div className={s.d} style={{ color: 'var(--muted)', fontSize: 12.5, lineHeight: 1.55 }}>
              Every action is one signature in MetaMask, settled atomically on Solana — you see the
              exact signatures before you commit.
            </div>
            <div className={s.actionsrow}>
              <button type="button" className={s.btn} onClick={() => onNav && onNav('/swap')}>
                Swap
              </button>
              <button type="button" className={`${s.btn} ${s.ghost}`} onClick={() => onNav && onNav('/lend')}>
                Lend
              </button>
              <button type="button" className={`${s.btn} ${s.ghost}`} onClick={() => onNav && onNav('/stake')}>
                Stake
              </button>
              <button type="button" className={`${s.btn} ${s.ghost}`} onClick={() => onNav && onNav('/pay')}>
                Pay
              </button>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
};

export { Home };
