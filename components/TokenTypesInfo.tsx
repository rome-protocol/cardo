'use client';
// Canonical explainer for the four Rome EVM token categories.
//
// Source: the docs/active/design/token-types-on-rome-evm.md §1.
// All copy strings (oneLiner / example / ethereumParity) are verbatim
// from §1.1-§1.4 of the spec. When the spec changes, update ENTRIES in
// lockstep — the spec is the source of truth, not this file.
//
// No external deps: styles live in /public/assets/token-types.css and
// are already wired via the root layout's <link rel="stylesheet">.

import { useState } from 'react';

type Entry = {
  category: 'native-gas' | 'wrapped-native' | 'erc20' | 'wrapped-spl';
  title: string;
  oneLiner: string;
  example: string;
  badge: string;
  ethereumParity: string;
};

const ENTRIES: Entry[] = [
  {
    category: 'native-gas',
    title: 'Native gas token',
    oneLiner:
      "The chain's gas token (what you pay fees in). Not an ERC20 — same role as ETH on Ethereum.",
    example: 'e.g. USDC on Rome-Rome, where fees are paid in USDC',
    badge: 'GAS',
    ethereumParity: 'ETH on Ethereum',
  },
  {
    category: 'wrapped-native',
    title: 'Wrapped native gas',
    oneLiner:
      'The ERC20 wrapper of the gas token. Needed to use gas inside DEX pools, lending markets, etc. — same role as WETH.',
    example: 'e.g. WUSDC wraps native USDC',
    badge: 'WRAP',
    ethereumParity: 'WETH on Ethereum',
  },
  {
    category: 'erc20',
    title: 'Plain ERC20',
    oneLiner:
      "A standard ERC20 deployed directly on Rome. Same contract shape you'd write on Ethereum.",
    example: "e.g. a project's own app token",
    badge: 'ERC20',
    ethereumParity: 'Any ERC20 on Ethereum',
  },
  {
    category: 'wrapped-spl',
    title: 'Wrapped SPL',
    oneLiner:
      'An ERC20 that represents a Solana SPL mint. Issued through ERC20SPLFactory; 1:1 redeemable with the underlying SPL on the Solana side.',
    example: 'e.g. an SPL stablecoin brought over without bridging state',
    badge: 'WRAPPED SPL',
    ethereumParity: 'None — this is the Rome-specific category',
  },
];

export function TokenTypesInfo() {
  const [open, setOpen] = useState(false);
  return (
    <section className="token-types-info">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="tti-header"
        aria-expanded={open}
      >
        <span className="eyebrow">Token types on Rome</span>
        <span className="tti-caret" aria-hidden="true">
          {open ? '−' : '+'}
        </span>
      </button>
      {open && (
        <ul className="tti-list">
          {ENTRIES.map((e) => (
            <li key={e.category} className="tti-row">
              <span className={`tti-badge tti-badge-${e.category}`}>
                {e.badge}
              </span>
              <div className="tti-body">
                <div className="tti-title">{e.title}</div>
                <div className="tti-one-liner">{e.oneLiner}</div>
                <div className="tti-example">{e.example}</div>
                <div className="tti-eth">
                  Ethereum parity: <em>{e.ethereumParity}</em>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
