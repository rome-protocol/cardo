'use client';
// DesignShell — the dark chrome for act|see routes. Two-level navigation:
//   1. top bar = ACTION categories (what you want to do)
//   2. venue sub-bar = the protocols within the active category (which DEX /
//      market), shown only on multi-venue categories (Swap/Lend/Stake).
// A user picks an action, then a venue — the venue is never a top-level peer of
// the action it belongs to. The .shell ancestor supplies the palette to the rig.

import { useState } from 'react';
import Link from 'next/link';
import { useAccount, useSwitchChain } from 'wagmi';
import type { Wallet } from '../../app/wallet-context';
import { useEnv } from '../../lib/env-context';
import { activeChain, chainsForNetwork } from '../../lib/chain-config';
import s from './actsee.module.css';
import { CATEGORIES, VENUES, categoryOf } from './nav-config';

// Header chain switcher — a the Rome web app-style dropdown over the Rome chains this
// DEPLOYMENT serves: the compiled-in chains on the active chain's network
// (devnet deploy → devnet chains only; testnet deploy → testnet chains only).
// Picking one sets the runtime override (useEnv.setChainId) so every hook
// re-points via useActiveChainId, and — when a wallet is connected — also
// asks it to switch networks. Every offered chain is already in the wagmi
// config, so this never rebuilds/remounts wagmi.
function ChainSwitcher() {
  const { chainId, setChainId } = useEnv();
  const { switchChainAsync } = useSwitchChain();
  const { isConnected } = useAccount();
  const [open, setOpen] = useState(false);
  const active = activeChain(chainId);
  const chains = chainsForNetwork(active.network);

  const pick = async (id: number) => {
    // 1. app-level: re-point every hook at the chosen chain (it's already in the
    //    wagmi config, so reads switch immediately).
    setChainId(id);
    setOpen(false);
    // 2. wallet: best-effort switch. switchChainAsync (not the fire-and-forget
    //    switchChain) is what reliably reaches MetaMask AND triggers
    //    wallet_addEthereumChain when the chain isn't in the wallet yet (wagmi
    //    auto-adds on the 4902 "unrecognized chain" error using the chain's
    //    config). Rejection/absence is fine — the wrong-network banner then
    //    nudges the user; reads already target the chosen chain.
    if (isConnected) {
      try {
        await switchChainAsync({ chainId: id });
      } catch (e) {
        console.warn('[cardo] wallet did not switch/add network', e);
      }
    }
  };

  return (
    <div className={s.chainwrap}>
      <button
        type="button"
        className={s.chainpill}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Switch Rome chain"
      >
        <span className={`${s.dot} ${s.sol}`} />
        {active?.name} <span className={s.chainid}>· {active?.id}</span>
        <span className={s.car}>▾</span>
      </button>
      {open && (
        <>
          <div className={s.chainscrim} onClick={() => setOpen(false)} />
          <ul className={s.chainmenu} role="listbox">
            {chains.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={c.id === chainId}
                  className={c.id === chainId ? s.chainon : undefined}
                  onClick={() => { void pick(c.id); }}
                >
                  <span className={`${s.dot} ${s.sol}`} />
                  <span className={s.chainnm}>{c.name}</span>
                  <span className={s.chainid}>{c.id}</span>
                  {c.id === chainId && <span className={s.chk}>✓</span>}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

// Navigation config (CATEGORIES / VENUES / categoryOf) lives in ./nav-config so
// its display order is unit-testable — imported at the top of this file.

export function DesignShell({
  route,
  chain = 'rome',
  wallet,
  onConnect,
  onOpenWallet,
  onSwitchChain,
  headerRight,
  children,
}: {
  route: string;
  /// 'rome' (default) = EVM chain switcher + EVM wallet button. 'solana' =
  /// the Solana-native lane (orchestrator): no EVM switcher/wallet, no EVM
  /// wrong-network banner. The header-right cluster is supplied by
  /// `headerRight` (the Solana-mainnet pill + wallet button, rendered inside
  /// the Solana provider by the caller) so the wallet sits in the header just
  /// like every other route.
  chain?: 'rome' | 'solana';
  wallet: Wallet;
  onConnect: () => void;
  onOpenWallet: () => void;
  onSwitchChain: () => void;
  headerRight?: React.ReactNode;
  children: React.ReactNode;
}) {
  const solana = chain === 'solana';
  const activeCat = categoryOf(route);
  const venues = VENUES[activeCat];
  const walletShort = wallet.address
    ? `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`
    : '';

  return (
    <div className={s.shell}>
      <header className={s.bar}>
        <Link className={s.brand} href="/">
          <span className={s.mark}>
            CAR<b>DO</b>
          </span>
          <span className={s.by}>on Rome</span>
        </Link>
        <nav className={s.links}>
          {CATEGORIES.map((c) => (
            <Link key={c.key} href={c.href} className={activeCat === c.key ? s.on : undefined}>
              {c.label}
            </Link>
          ))}
        </nav>
        <div className={s.baractions}>
          {solana ? (
            headerRight ?? (
              <span className={s.chainpill} style={{ cursor: 'default' }}>
                <span className={`${s.dot} ${s.sol}`} /> Solana <span className={s.chainid}>· Mainnet</span>
              </span>
            )
          ) : (
            <>
              <ChainSwitcher />
              {wallet.connected ? (
                <button type="button" className={`${s.btn} ${s.ghost}`} title={wallet.address ?? ''} onClick={onOpenWallet}>
                  {walletShort}
                </button>
              ) : (
                <button type="button" className={s.btn} onClick={onConnect}>
                  Connect wallet
                </button>
              )}
            </>
          )}
        </div>
      </header>

      {venues && (
        <div className={s.venuebar}>
          <span className={s.vlabel}>venue</span>
          <div className={s.vpills}>
            {venues.map((v) => (
              <Link key={v.href} href={v.href} className={v.href === route ? s.von : undefined}>
                {v.label}
              </Link>
            ))}
          </div>
        </div>
      )}

      {!solana && wallet.isWrongNetwork && (
        <div className={s.netbanner}>
          You&apos;re on chain {wallet.chainId}. Switch to <b>Rome</b> to use Cardo.
          <button type="button" onClick={onSwitchChain}>
            Switch network
          </button>
        </div>
      )}

      {children}

      <footer className={s.footer}>
        <span>CARDO · APP DISTRIBUTION PORTAL ON ROME</span>
        <span>EVM ⇄ SOLANA · SETTLED ATOMICALLY</span>
      </footer>
    </div>
  );
}
