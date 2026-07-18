// PumpSwap AMM (Pump.fun's post-graduation venue) program constants
// for the Cardo `/swap-pumpswap` integration.
//
// **Source of truth**: github.com/pump-fun/pump-public-docs (idl/pump_amm.json).
// All discriminators below are sha256("global:<method>")[..8] (Anchor 0.x).
//
// Devnet bootstrap state (verified 2026-04-25):
//   - PumpSwap AMM (pAMMBay6...)         executable=true ✓
//   - PumpSwap fee_program (pfeeUxB6...) executable=true ✓
//   - GlobalConfig (ADyA8hde...)         space=907, admin=GUYCUEpx... ✓
//   - fee_config PDA under fee_program (5PHirr8j...) space=2512 ✓
//   - 4133 Pool accounts on devnet, 4074 WSOL-paired
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md
// (Family 3, A6 — auto-deploy / A0 promotion via existing devnet liquidity).

import type { Hex } from 'viem';
import { pubkeyBs58ToBytes32 } from './solana-pda';
import { solanaProgramId } from './solana-programs';

// ─────────────────────────────────────────────────────────────────────
// Program ids (from @rome-protocol/registry)
// ─────────────────────────────────────────────────────────────────────

/// PumpSwap AMM program. Same address on devnet + mainnet.
export const PUMPSWAP_PROGRAM: Hex = pubkeyBs58ToBytes32(
  solanaProgramId('pumpSwap', 'devnet'),
);

/// PumpSwap fee program (a sibling program; owns the fee_config PDA).
/// PDA `fee_config` is derived under THIS program, not under PumpSwap AMM.
export const PUMPSWAP_FEE_PROGRAM: Hex = pubkeyBs58ToBytes32(
  'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ',
);

// ─────────────────────────────────────────────────────────────────────
// Singleton accounts
// ─────────────────────────────────────────────────────────────────────

/// Canonical GlobalConfig on devnet.
/// Discovered via `getProgramAccounts` filtered by GlobalConfig disc.
/// admin: GUYCUEpxSkm1ccDo3LSKMR4Xpe5bgMnEZaFygWUSEVH3
/// lp_fee_basis_points: 20  (0.20%)
/// protocol_fee_basis_points: 5  (0.05%)
export const PUMPSWAP_GLOBAL_CONFIG: Hex = pubkeyBs58ToBytes32(
  'ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw',
);

/// Canonical `fee_config` PDA (derived under fee_program; pinned because
/// the seed is a 32-byte literal published in the IDL).
export const PUMPSWAP_FEE_CONFIG: Hex = pubkeyBs58ToBytes32(
  '5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx',
);

/// Default protocol fee recipient (slot 0 of GlobalConfig.protocol_fee_recipients).
/// Devnet: 12e2F4DKkD3Lff6WPYsU7Xd76SHPEyN9T8XSsTJNF8oT.
/// The IDL allows any of the 8 published recipients; we pin the first one.
export const PUMPSWAP_PROTOCOL_FEE_RECIPIENT: Hex = pubkeyBs58ToBytes32(
  '12e2F4DKkD3Lff6WPYsU7Xd76SHPEyN9T8XSsTJNF8oT',
);

// ─────────────────────────────────────────────────────────────────────
// Anchor instruction discriminators
// (raw 8 bytes from the IDL, encoded as 0x-prefixed hex)
// ─────────────────────────────────────────────────────────────────────

/// `buy` — user spends quote_token, receives base_token.
/// IDL: [102, 6, 61, 18, 1, 218, 235, 234]
export const BUY_DISC: Hex = '0x66063d1201daebea';

/// `sell` — user spends base_token, receives quote_token.
/// IDL: [51, 230, 133, 164, 1, 127, 131, 173]
export const SELL_DISC: Hex = '0x33e685a4017f83ad';

/// `deposit` — add liquidity, receive LP tokens. IDL:
/// [242, 35, 198, 137, 82, 225, 242, 182]
export const PUMPSWAP_DEPOSIT_DISC: Hex = '0xf223c68952e1f2b6';

/// `withdraw` — burn LP tokens, redeem proportional base + quote. IDL:
/// [183, 18, 70, 156, 148, 109, 161, 34]
export const PUMPSWAP_WITHDRAW_DISC: Hex = '0xb712469c946da122';

// ─────────────────────────────────────────────────────────────────────
// PDA seeds
// ─────────────────────────────────────────────────────────────────────

/// Seed for the program's per-program event authority PDA.
/// PDA(["__event_authority"], PUMPSWAP_PROGRAM).
export const EVENT_AUTHORITY_SEED = Buffer.from('__event_authority');

/// Seed for `coin_creator_vault_authority` PDA.
/// PDA(["creator_vault", coin_creator], PUMPSWAP_PROGRAM).
export const CREATOR_VAULT_SEED = Buffer.from('creator_vault');

/// Seed for the global volume accumulator PDA.
/// PDA(["global_volume_accumulator"], PUMPSWAP_PROGRAM).
export const GLOBAL_VOLUME_ACCUMULATOR_SEED = Buffer.from(
  'global_volume_accumulator',
);

/// Seed for the per-user volume accumulator PDA.
/// PDA(["user_volume_accumulator", user_pubkey], PUMPSWAP_PROGRAM).
export const USER_VOLUME_ACCUMULATOR_SEED = Buffer.from(
  'user_volume_accumulator',
);

// ─────────────────────────────────────────────────────────────────────
// Pool account
// ─────────────────────────────────────────────────────────────────────

/// IDL discriminator for the `Pool` account. Used in `getProgramAccounts`
/// memcmp filter to enumerate pools.
export const POOL_DISC: number[] = [241, 154, 109, 4, 17, 177, 109, 188];

/// Total on-chain size of a Pool account (bytes), per the IDL layout.
/// 8 disc + 1 bump + 2 index + 6×32 pubkeys + 8 lp_supply + 32 coin_creator
/// + 1 is_mayhem_mode + 1 is_cashback_coin = 245.
export const POOL_SIZE = 245;

// ─────────────────────────────────────────────────────────────────────
// CU budget (empirical estimate; PumpSwap buy is ~23 accounts and
// touches 2 vaults + Pyth-priced creator/protocol fees + volume tracking).
// ─────────────────────────────────────────────────────────────────────

export const CU_PUMPSWAP_BUY = 220_000n;
export const CU_PUMPSWAP_SELL = 200_000n;
