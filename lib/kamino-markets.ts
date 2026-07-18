// Curated Kamino Lend market registry for Cardo /lend.
//
// One devnet market is wired today — the only one with both Circle
// USDC + canonical WSOL (the same mints Cardo /swap already uses). On
// mainnet, the canonical "Main Market" 7u3HeHx…PfF is the production-
// active analog (55 reserves, top by activity in 2026-04-25 probe).
//
// See the docs/active/technical/2026-04-25-cardo-lend-kamino-triage.md §7.1
// for the cross-check that picked this market.
//
// The Solana-side accounts (market, reserves, vaults, mints) are substrate
// constants — shared by every Rome chain on Solana devnet. Only the EVM
// `wrapper` field is per-Rome-chain, so the market is built per chain at
// CALL time (a module-level build froze the boot default's wrappers into
// the client bundle — wrong on every non-default chain). Memoized per
// chain id, so returned objects are identity-stable for hook deps.
//
// New markets to add later:
//   - Mainnet Main Market (`7u3HeHx…PfF`) when Cardo gates onto mainnet.
//   - User-discovered markets via /pool/new-style flow (post-MVP).

import type { Hex } from 'viem';
import { pubkeyBs58ToBytes32 } from './solana-pda';
import { activeChain } from './chain-config';

export type KaminoReserve = {
  /// Display label, e.g. "WUSDC".
  symbol: string;
  /// On-chain reserve account.
  reserve: Hex;
  /// Reserve liquidity mint (the SPL the user supplies / borrows).
  liquidityMint: Hex;
  /// On-chain decimals of the liquidity mint.
  decimals: number;
  /// EVM wrapper address for the same underlying SPL — used to read
  /// user balance from the Cardo /swap pipeline (so /lend reuses the
  /// already-merged EVM/Solana balance hook).
  wrapper: `0x${string}`;
  /// Reserve liquidity supply ATA (vault holding deposited liquidity).
  /// Source: Reserve struct offset 160. Hardcoded post-probe; should
  /// move to an on-chain Reserve-state hook when one is written.
  liquiditySupply: Hex;
  /// Reserve liquidity fee ATA (Kamino's protocol fee receiver).
  /// Source: Reserve struct offset 192.
  feeReceiver: Hex;
  /// Reserve collateral mint (cToken minted on supply, burned on
  /// withdraw). Source: Reserve struct offset 2560.
  collateralMint: Hex;
  /// Reserve collateral supply vault (= reserve_destination_deposit_collateral
  /// in the Anchor IDL). Source: Reserve struct offset 2600.
  collateralSupply: Hex;
};

export type KaminoMarket = {
  /// Display label.
  label: string;
  /// Lending market PDA (Kamino primary state).
  lendingMarket: Hex;
  /// Curated list of reserves the UI surfaces. Subset of all reserves
  /// in the market; we only show reserves whose liquidity mint pairs
  /// with a wrapper Cardo already knows about.
  reserves: KaminoReserve[];
};

const marketsByChain = new Map<number, KaminoMarket[]>();

/// Rome-targeted Kamino market (Solana devnet side) for the given Rome
/// chain. Locked in via triage §7.1 — the only devnet market with both
/// Circle USDC + canonical WSOL.
export function kaminoMainMarket(chainId?: number): KaminoMarket {
  return kaminoMarkets(chainId)[0];
}

/// Registry of all Kamino markets routable from Cardo on the given Rome
/// chain. Single entry today; grows as we add mainnet + user-discovered
/// markets.
export function kaminoMarkets(chainId?: number): KaminoMarket[] {
  const chain = activeChain(chainId);
  let markets = marketsByChain.get(chain.id);
  if (!markets) {
    // WUSDC + WWSOL canonical wrappers — registry-driven, per Rome chain.
    const { wUsdc: WUSDC_WRAPPER, wWsol: WWSOL_WRAPPER } = chain.wrappers;
    markets = [
      {
        label: 'Kamino Main (devnet)',
        lendingMarket: pubkeyBs58ToBytes32('HqCoqWT42Qdg1fbsWFo6TNCkH6eSY2MtxHFEkPoBvCHm'),
        reserves: [
          {
            symbol: 'WUSDC',
            reserve: pubkeyBs58ToBytes32('DHP5csgS8ba2dFAqgM5dqNXoUw3x9EWaPwYXVACQ4Wxn'),
            liquidityMint: pubkeyBs58ToBytes32('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'),
            decimals: 6,
            wrapper: WUSDC_WRAPPER,
            // Reserve sub-accounts probed on-chain 2026-04-25:
            liquiditySupply: pubkeyBs58ToBytes32('7U7oFUGSNdYMmyKEUrw28P52Ld4Uw6Mr1s335fK3X6Rz'),
            feeReceiver: pubkeyBs58ToBytes32('BgKKmsiRdrjx6K22dffCPFZRsGtvdZLtop2C1EeJoDr7'),
            collateralMint: pubkeyBs58ToBytes32('EK8T1MrJ5DVmjcJ7hg7pqejTP3fPSVYxKq9ykHLvkSQ4'),
            collateralSupply: pubkeyBs58ToBytes32('BRJRC1Uo6DfRgu4UdFMTzdVTXt2n3zG71aNRSVWLfqMo'),
          },
          {
            symbol: 'WWSOL',
            reserve: pubkeyBs58ToBytes32('AgcJQCFPuQcHRZkUjDhdQcudExKNiwWwPcwFf3Dkzsgb'),
            liquidityMint: pubkeyBs58ToBytes32('So11111111111111111111111111111111111111112'),
            decimals: 9,
            wrapper: WWSOL_WRAPPER,
            // Reserve sub-accounts probed on-chain 2026-04-25:
            liquiditySupply: pubkeyBs58ToBytes32('DqzaYLVX73SKQXJAAh1ujeLKYuyhnw4yPJJgp6LoCmB5'),
            feeReceiver: pubkeyBs58ToBytes32('8qbVWV9ACEqa99TXKfxsPcMqQDBijYmxo728GYxLNBcz'),
            collateralMint: pubkeyBs58ToBytes32('GyPynmAPQd7c1dzU8HvLZSrzSwyZYZQad9yqeLMgH283'),
            collateralSupply: pubkeyBs58ToBytes32('AVAJk7iJaoH8PaA9oNx6ykUrokbLToGfQLdmDBPD2A3C'),
          },
        ],
      },
    ];
    marketsByChain.set(chain.id, markets);
  }
  return markets;
}

/// Symbol aliases — drawer's hardcoded RESERVES list shows display
/// symbols (USDC, SOL) while the registry stores Rome-wrapped names
/// (WUSDC, WWSOL) per token-types-on-rome-evm spec §2. Map both.
const SYMBOL_ALIASES: Record<string, string> = {
  USDC: 'WUSDC',
  WUSDC: 'WUSDC',
  WSOL: 'WWSOL',
  SOL: 'WWSOL',
  WWSOL: 'WWSOL',
};

/// Lookup helpers: by symbol (with aliasing), by reserve.
export function findReserveBySymbol(symbol: string, chainId?: number): {
  market: KaminoMarket;
  reserve: KaminoReserve;
} | undefined {
  const canonical = SYMBOL_ALIASES[symbol] ?? symbol;
  for (const m of kaminoMarkets(chainId)) {
    const r = m.reserves.find((r) => r.symbol === canonical);
    if (r) return { market: m, reserve: r };
  }
  return undefined;
}
export function findMarketByReserve(reserveHex: Hex, chainId?: number): KaminoMarket | undefined {
  const lc = reserveHex.toLowerCase();
  return kaminoMarkets(chainId).find((m) =>
    m.reserves.some((r) => r.reserve.toLowerCase() === lc),
  );
}
