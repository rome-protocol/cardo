// Curated registry of SPL stake-pool LSTs that Cardo /stake supports.
//
// Each entry resolves to the constant accounts needed by
// `lib/stake-pool-instructions.ts::buildDepositSolInvoke`. Reserve
// stake + manager fee account + pool mint are read once from on-chain
// StakePool and committed here as constants.
//
// Network targeting:
// - Rome's bridge currently goes to **Solana devnet**, not mainnet
//   (WWSOL wraps the canonical devnet WSOL mint, etc.). Sprint 1 ships
//   against a maintained devnet stake pool so the deposit path is
//   actually testable.
// - Production LSTs (JitoSOL, jupSOL, bSOL, dSOL, etc.) live on Solana
//   mainnet only. Surfacing them in Cardo requires Rome mainnet
//   bridge support — out of scope for Sprint 1.
//
// The mainnet registry below is preserved as a reference / future
// switch — when Rome supports mainnet bridges, flip the active set.
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md
// (Family 1, Phase A — Sprint 1).

import type { Hex } from 'viem';
import { pubkeyBs58ToBytes32 } from './solana-pda';
import type { StakePoolAccounts } from './stake-pool-instructions';

export type StakePoolRegistryEntry = {
  /// Display symbol (e.g. "JitoSOL", "bSOL", "DevTestSOL").
  symbol: string;
  /// Display name.
  name: string;
  /// 1-line "why this LST" copy for the UI.
  blurb: string;
  /// Headline APY (string, surfaced in UI; updated periodically).
  apy: string;
  /// Resolved pool accounts for buildDepositSolInvoke.
  pool: StakePoolAccounts;
  /// Network the pool lives on. Sprint 1 only ships `'devnet'` entries
  /// (matching Rome's bridge target).
  network: 'devnet' | 'mainnet';
  /// Whether this is currently enabled in the UI.
  enabled: boolean;
};

// ─────────────────────────────────────────────────────────────────────
// bSOL on devnet — BlazeStake's devnet stake pool (Sprint 1 default)
//
// Crucially, this is BlazeStake's actually-maintained devnet pool. Pool
// mint `bSo13r4Tki...` is the same canonical bSOL mint as on mainnet
// (only the pool/reserve/staker pubkeys differ between devnet and
// mainnet). They run the crank — last_update_epoch matches the current
// devnet epoch. Reserve has ~423 SOL.
//
// Earlier choice (`5cJnHu3sadPBeDdj...`) was abandoned: had 558 SOL in
// reserve but its `last_update_epoch=842` was 218 epochs stale, so
// `DepositSol` immediately reverted with `StakeListAndPoolOutOfDate`
// (error code 17). Lesson: reserve lamports alone are not "alive"; the
// pool also has to be cranked recently (within ~1 epoch).
//
// All pubkeys verified via getAccountInfo on api.devnet.solana.com,
// 2026-04-25.
// ─────────────────────────────────────────────────────────────────────

const BSOL_DEVNET_POOL = 'azFVdHtAJN8BX3sbGAYkXvtdjdrT5U6rj9rovvUFos9';
const BSOL_DEVNET_RESERVE = 'aRkys1kVHeysrcn9bJFat9FkvoyyYD8M1kK286X3Aro';
const BSOL_DEVNET_MINT = 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1';
const BSOL_DEVNET_MANAGER_FEE = 'Dpo148tVGewDPyh2FkGV18gouWctbdX2fHJopJGe9xv1';

const BSOL_DEVNET: StakePoolRegistryEntry = {
  symbol: 'bSOL · devnet',
  name: 'BlazeStake (devnet)',
  blurb:
    "BlazeStake's devnet stake pool — same canonical bSOL mint as mainnet, cranked every epoch.",
  apy: 'devnet · cranked',
  pool: {
    stakePool: pubkeyBs58ToBytes32(BSOL_DEVNET_POOL),
    reserveStake: pubkeyBs58ToBytes32(BSOL_DEVNET_RESERVE),
    poolMint: pubkeyBs58ToBytes32(BSOL_DEVNET_MINT),
    managerFeeAccount: pubkeyBs58ToBytes32(BSOL_DEVNET_MANAGER_FEE),
    referralFeeAccount: pubkeyBs58ToBytes32(BSOL_DEVNET_MANAGER_FEE),
  },
  network: 'devnet',
  enabled: true,
} as const;

// ─────────────────────────────────────────────────────────────────────
// Mainnet entries — preserved for when Rome mainnet bridges land.
// All `enabled: false` until then.
//
// Pool struct verified live on Solana mainnet 2026-04-25.
// ─────────────────────────────────────────────────────────────────────

const JITOSOL_POOL = 'Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb';
const JITOSOL_MINT = 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn';
const JITOSOL_RESERVE = 'BgKUXdS29YcHCFrPm5M8oLHiTzZaMDjsebggjoaQ6KFL';
const JITOSOL_MANAGER_FEE = '8yoigZfzZ1nNaadumY9uPVD118225UYHTDpmjpr2nrSa';

const JITOSOL: StakePoolRegistryEntry = {
  symbol: 'JitoSOL',
  name: 'Jito Staked SOL',
  blurb: 'MEV-boosted Solana staking. Highest-TVL LST.',
  apy: '~7.0% APY',
  pool: {
    stakePool: pubkeyBs58ToBytes32(JITOSOL_POOL),
    reserveStake: pubkeyBs58ToBytes32(JITOSOL_RESERVE),
    poolMint: pubkeyBs58ToBytes32(JITOSOL_MINT),
    managerFeeAccount: pubkeyBs58ToBytes32(JITOSOL_MANAGER_FEE),
    referralFeeAccount: pubkeyBs58ToBytes32(JITOSOL_MANAGER_FEE),
  },
  network: 'mainnet',
  enabled: false, // gated on Rome mainnet bridge support
} as const;

// ─────────────────────────────────────────────────────────────────────

export const STAKE_POOL_REGISTRY: ReadonlyArray<StakePoolRegistryEntry> = [
  BSOL_DEVNET,
  JITOSOL,
];

export function findStakePoolBySymbol(
  symbol: string,
): StakePoolRegistryEntry | undefined {
  return STAKE_POOL_REGISTRY.find((e) => e.symbol === symbol);
}

export function findStakePoolByMint(
  mintHex: Hex,
): StakePoolRegistryEntry | undefined {
  return STAKE_POOL_REGISTRY.find((e) => e.pool.poolMint === mintHex);
}

export const ENABLED_STAKE_POOLS: ReadonlyArray<StakePoolRegistryEntry> =
  STAKE_POOL_REGISTRY.filter((e) => e.enabled);
