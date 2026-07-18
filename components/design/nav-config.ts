// Navigation config for the act|see shell, extracted from DesignShell so display
// order is unit-testable (DesignShell itself can't be imported in a node test
// env — it pulls in React, next/link, and a CSS module).
//
// Two levels:
//   CATEGORIES — top-bar actions (what you want to do)
//   VENUES     — protocols within a multi-venue category (which DEX / market)
// Invariant: a category's top-nav href is its FIRST venue's href — the default a
// user lands on when they pick that action. Keep the two in sync (guarded by a
// unit test in tests/nav-order.test.ts).

export type Category = { key: string; label: string; href: string };
export type Venue = { label: string; href: string };

// Top-level actions.
export const CATEGORIES: Category[] = [
  { key: 'portfolio', label: 'Portfolio', href: '/' },
  { key: 'bridge', label: 'Bridge', href: '/bridge' },
  { key: 'swap', label: 'Swap', href: '/swap' },
  { key: 'perps', label: 'Perps', href: '/perps' },
  { key: 'lend', label: 'Lend', href: '/lend-mango' },
  { key: 'stake', label: 'Stake', href: '/stake' },
  { key: 'pay', label: 'Pay', href: '/pay' },
  { key: 'send', label: 'Send', href: '/send' },
  { key: 'compose', label: 'Compose', href: '/compose' },
  // Orchestrator: the Solana-native (Phantom, mainnet) NL surface where the
  // working Jupiter perp + swap/stake/yield/compose intents execute. Distinct
  // wallet/chain model from the act|see EVM routes above, so it's its own
  // chrome-less product — but it must be reachable, hence this nav entry.
  { key: 'orchestrator', label: 'Orchestrator', href: '/orchestrator' },
];

// Venues within multi-venue categories. First entry is the category's default
// route (the top-nav target) — see the invariant note above.
export const VENUES: Record<string, Venue[]> = {
  swap: [
    { label: 'Meteora', href: '/swap' },
    { label: 'Orca', href: '/orca' },
    { label: 'DLMM', href: '/swap-dlmm' },
    { label: 'Meteora v2', href: '/swap-meteora-v2' },
    { label: 'Phoenix', href: '/swap-phoenix' },
    { label: 'Raydium', href: '/swap-raydium' },
    { label: 'Raydium AMM', href: '/swap-raydium-amm' },
    { label: 'Raydium CLMM', href: '/swap-raydium-clmm' },
    // Pump.fun ('/swap-pumpfun') + PumpSwap ('/swap-pumpswap') removed from nav:
    // both need a user-supplied memecoin mint to load a pool/curve (no default),
    // so the swap can't quote in-UI without an external paste — breaks the
    // "must work, in-UI only" rule. Re-add with an in-UI mint search/trending
    // picker (enumerate curves via getProgramAccounts) so they're self-contained.
  ],
  lend: [
    { label: 'Mango', href: '/lend-mango' },
    { label: 'Drift', href: '/lend-drift' },
    // Kamino ('/lend') removed from nav: its supply/borrow write is not wired
    // (CTA disabled, every submit reverts) and the screen pointed users off-site
    // — both break the "must work, in-UI only" rule. Re-add this entry once the
    // klein/klend supply+borrow calldata is rebuilt and lands a funded test.
  ],
  stake: [
    { label: 'Stake pool', href: '/stake' },
    { label: 'Marinade', href: '/stake-marinade' },
  ],
};

// route → category key.
const ROUTE_CATEGORY: Record<string, string> = (() => {
  const m: Record<string, string> = {
    '/': 'portfolio',
    '/bridge': 'bridge',
    '/perps': 'perps',
    '/pay': 'pay',
    '/send': 'send',
    '/compose': 'compose',
    '/orchestrator': 'orchestrator',
  };
  for (const [cat, venues] of Object.entries(VENUES)) {
    for (const v of venues) m[v.href] = cat;
  }
  return m;
})();

export function categoryOf(route: string): string {
  return ROUTE_CATEGORY[route] ?? '';
}
