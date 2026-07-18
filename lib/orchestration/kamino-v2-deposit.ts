// Kamino v2 deposit: refresh_reserve + deposit_reserve_liquidity_and_obligation_collateral_v2
// + supporting init ixs (init_user_metadata, init_obligation, init_obligation_farms_for_reserve).
//
// Discriminators verified by decoding live mainnet txs.
// Account lists verified against real on-chain successful deposits.
// PDA derivations verified by reverse-engineering known good txs.
//
// All ix builders here produce TransactionInstructions signed by a regular
// Solana keypair (the "stand-in" for what would be the user's Rome PDA).

import { PublicKey, TransactionInstruction, SystemProgram } from '@solana/web3.js';
import { solanaProgramId } from '../solana-programs';

// Program IDs from canonical @rome-protocol/registry. Orchestrator runs
// against Solana mainnet (the user's actual wallet pays); 'mainnet' is
// the default network arg.
const KLEND = new PublicKey(solanaProgramId('kaminoLend'));
const FARMS = new PublicKey(solanaProgramId('kaminoFarms'));
const SYSVAR_RENT = new PublicKey('SysvarRent111111111111111111111111111111111');
const INSTRUCTIONS_SYSVAR = new PublicKey('Sysvar1nstructions1111111111111111111111111');
const TOKEN_PROGRAM = new PublicKey(solanaProgramId('splToken'));

// Discriminators (sha256("global:<name>")[..8])
const DISC_REFRESH_OBLIGATION = Buffer.from('218493e497c04859', 'hex');
const DISC_INIT_USER_METADATA = Buffer.from('75a9b045c5170fa2', 'hex');
const DISC_INIT_OBLIGATION    = Buffer.from('fb0ae74c1b0b9f60', 'hex');
const DISC_INIT_FARMS         = Buffer.from('883f0fbad398a8a4', 'hex'); // init_obligation_farms_for_reserve
const DISC_REFRESH_RESERVE    = Buffer.from('02da8aeb4fc91966', 'hex');
const DISC_DEPOSIT_V2         = Buffer.from('d8e0bf1bcc9766af', 'hex');

// PDA derivations
export function deriveUserMetadata(owner: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('user_meta'), owner.toBuffer()],
    KLEND,
  );
  return pda;
}

export function deriveVanillaObligation(owner: PublicKey, market: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from([0]), Buffer.from([0]), owner.toBuffer(), market.toBuffer(), PublicKey.default.toBuffer(), PublicKey.default.toBuffer()],
    KLEND,
  );
  return pda;
}

export function deriveLendingMarketAuthority(market: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('lma'), market.toBuffer()],
    KLEND,
  );
  return pda;
}

/// PDA([b"user", reserveFarmState, obligation], FARMS)
export function deriveObligationFarmUserState(
  reserveFarmState: PublicKey,
  obligation: PublicKey,
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('user'), reserveFarmState.toBuffer(), obligation.toBuffer()],
    FARMS,
  );
  return pda;
}

// ─────────────────────────────────────────────────────────────────────
// init_user_metadata — one-time per user
// ─────────────────────────────────────────────────────────────────────

/// IDL: init_user_metadata(user_lookup_table: Pubkey)
/// 6 accounts: owner(s,r), fee_payer(s,w), user_metadata(w),
///   referrer_user_metadata(r, optional, pass KLend program for None),
///   rent, system_program
export function buildInitUserMetadataIx(args: {
  owner: PublicKey;
  feePayer: PublicKey;
}): TransactionInstruction {
  const userMetadata = deriveUserMetadata(args.owner);
  const keys = [
    { pubkey: args.owner,              isSigner: true,  isWritable: false },
    { pubkey: args.feePayer,           isSigner: true,  isWritable: true  },
    { pubkey: userMetadata,            isSigner: false, isWritable: true  },
    { pubkey: KLEND,                   isSigner: false, isWritable: false }, // referrer = None
    { pubkey: SYSVAR_RENT,             isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  // user_lookup_table = Pubkey::default()
  const data = Buffer.concat([DISC_INIT_USER_METADATA, PublicKey.default.toBuffer()]);
  return new TransactionInstruction({ programId: KLEND, keys, data });
}

// ─────────────────────────────────────────────────────────────────────
// init_obligation — one-time per (user, market)
// ─────────────────────────────────────────────────────────────────────

/// IDL: init_obligation(args: InitObligationArgs { tag: u8, id: u8 })
/// 9 accounts: owner(s), feePayer(s,w), obligation(w), market(r),
///   seed1(r), seed2(r), userMetadata(r), rent, system_program
export function buildInitObligationIx(args: {
  owner: PublicKey;
  feePayer: PublicKey;
  market: PublicKey;
}): TransactionInstruction {
  const obligation = deriveVanillaObligation(args.owner, args.market);
  const userMetadata = deriveUserMetadata(args.owner);
  const keys = [
    { pubkey: args.owner,              isSigner: true,  isWritable: false },
    { pubkey: args.feePayer,           isSigner: true,  isWritable: true  },
    { pubkey: obligation,              isSigner: false, isWritable: true  },
    { pubkey: args.market,             isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // seed1 (Vanilla)
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // seed2 (Vanilla)
    { pubkey: userMetadata,            isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT,             isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  // tag = 0, id = 0 (Vanilla)
  const data = Buffer.concat([DISC_INIT_OBLIGATION, Buffer.from([0, 0])]);
  return new TransactionInstruction({ programId: KLEND, keys, data });
}

// ─────────────────────────────────────────────────────────────────────
// init_obligation_farms_for_reserve — one-time per (obligation, reserve)
// Mode: 0 = collateral, 1 = debt
// ─────────────────────────────────────────────────────────────────────

export function buildInitObligationFarmsIx(args: {
  owner: PublicKey;
  feePayer: PublicKey;
  obligation: PublicKey;
  reserve: PublicKey;
  reserveFarmState: PublicKey;
  market: PublicKey;
  mode: 0 | 1;
}): TransactionInstruction {
  const obligationFarmUserState = deriveObligationFarmUserState(args.reserveFarmState, args.obligation);
  const lendingMarketAuthority = deriveLendingMarketAuthority(args.market);
  // Account list (per Kamino source `InitObligationFarmsForReserve`):
  //   payer, owner, obligation, lending_market_authority, reserve, reserve_farm_state,
  //   obligation_farm, lending_market, farms_program, rent, system_program
  const keys = [
    { pubkey: args.feePayer,            isSigner: true,  isWritable: true  },
    { pubkey: args.owner,               isSigner: true,  isWritable: true  },
    { pubkey: args.obligation,          isSigner: false, isWritable: true  },
    { pubkey: lendingMarketAuthority,   isSigner: false, isWritable: true  },
    { pubkey: args.reserve,             isSigner: false, isWritable: true  },
    { pubkey: args.reserveFarmState,    isSigner: false, isWritable: true  },
    { pubkey: obligationFarmUserState,  isSigner: false, isWritable: true  },
    { pubkey: args.market,              isSigner: false, isWritable: false },
    { pubkey: FARMS,                    isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT,              isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId,  isSigner: false, isWritable: false },
  ];
  const data = Buffer.concat([DISC_INIT_FARMS, Buffer.from([args.mode])]);
  return new TransactionInstruction({ programId: KLEND, keys, data });
}

// ─────────────────────────────────────────────────────────────────────
// refresh_reserve — must precede deposit
// 6 accounts; for Scope-priced reserves pass system_program for the
// pyth/switchboard slots (3..6). Some reserves include scope_prices at
// slot 5 — to be safe we pass system_program for all 4 oracle slots
// since v2 deposit handles oracle internally via inner CPI.
// ─────────────────────────────────────────────────────────────────────

/// refresh_reserve — verified against real on-chain refresh for USDC main reserve.
/// Slot pattern (extracted from successful tx):
///   slot 2..4: KLend program (NOT system_program!) for None of Pyth/Switchboard
///   slot 5: Scope prices account (Kamino's own oracle aggregator)
export function buildRefreshReserveIx(args: {
  reserve: PublicKey;
  market: PublicKey;
  /// Pyth oracle. If reserve is Scope-priced, pass KLEND.
  pythOracle?: PublicKey;
  /// Switchboard oracle. If unused, pass KLEND.
  switchboardOracle?: PublicKey;
  /// Switchboard TWAP. If unused, pass KLEND.
  switchboardTwap?: PublicKey;
  /// Scope prices account. Required for Scope-priced reserves.
  scopePrices?: PublicKey;
}): TransactionInstruction {
  const keys = [
    { pubkey: args.reserve,                  isSigner: false, isWritable: true  },
    { pubkey: args.market,                   isSigner: false, isWritable: false },
    { pubkey: args.pythOracle ?? KLEND,      isSigner: false, isWritable: false },
    { pubkey: args.switchboardOracle ?? KLEND, isSigner: false, isWritable: false },
    { pubkey: args.switchboardTwap ?? KLEND, isSigner: false, isWritable: false },
    { pubkey: args.scopePrices ?? KLEND,     isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({ programId: KLEND, keys, data: DISC_REFRESH_RESERVE });
}

// ─────────────────────────────────────────────────────────────────────
// refresh_obligation — required after refresh_reserve, before deposit
// when obligation has been touched.
// IDL accounts: lending_market(r), obligation(w), [reserves to refresh] (r/w)
// ─────────────────────────────────────────────────────────────────────

export function buildRefreshObligationIx(args: {
  market: PublicKey;
  obligation: PublicKey;
  reserves?: PublicKey[]; // additional reserves to include in refresh chain
}): TransactionInstruction {
  const keys = [
    { pubkey: args.market,     isSigner: false, isWritable: false },
    { pubkey: args.obligation, isSigner: false, isWritable: true  },
    ...(args.reserves ?? []).map(r => ({ pubkey: r, isSigner: false, isWritable: true })),
  ];
  return new TransactionInstruction({ programId: KLEND, keys, data: DISC_REFRESH_OBLIGATION });
}

// ─────────────────────────────────────────────────────────────────────
// deposit_reserve_liquidity_and_obligation_collateral_v2
// 17 accounts (farms-enabled reserves)
// data: disc(8) || liquidity_amount(u64_le)
// ─────────────────────────────────────────────────────────────────────

export type KaminoV2DepositArgs = {
  owner: PublicKey;
  market: PublicKey;
  reserve: PublicKey;
  reserveLiquidityMint: PublicKey;
  reserveLiquiditySupply: PublicKey;
  reserveCollateralMint: PublicKey;
  reserveDestinationCollateral: PublicKey;
  userSourceLiquidity: PublicKey;
  reserveFarmState: PublicKey;
  amountIn: bigint;
};

export function buildKaminoV2DepositIx(args: KaminoV2DepositArgs): TransactionInstruction {
  const obligation = deriveVanillaObligation(args.owner, args.market);
  const lendingMarketAuthority = deriveLendingMarketAuthority(args.market);
  const obligationFarmUserState = deriveObligationFarmUserState(args.reserveFarmState, obligation);

  const keys = [
    { pubkey: args.owner,                       isSigner: true,  isWritable: false },
    { pubkey: obligation,                       isSigner: false, isWritable: true  },
    { pubkey: args.market,                      isSigner: false, isWritable: false },
    { pubkey: lendingMarketAuthority,           isSigner: false, isWritable: false },
    { pubkey: args.reserve,                     isSigner: false, isWritable: true  },
    { pubkey: args.reserveLiquidityMint,        isSigner: false, isWritable: false },
    { pubkey: args.reserveLiquiditySupply,      isSigner: false, isWritable: true  },
    { pubkey: args.reserveCollateralMint,       isSigner: false, isWritable: true  },
    { pubkey: args.reserveDestinationCollateral, isSigner: false, isWritable: true },
    { pubkey: args.userSourceLiquidity,         isSigner: false, isWritable: true  },
    { pubkey: KLEND,                            isSigner: false, isWritable: false }, // placeholder for "no user collateral output"
    { pubkey: TOKEN_PROGRAM,                    isSigner: false, isWritable: false }, // collateral token program
    { pubkey: TOKEN_PROGRAM,                    isSigner: false, isWritable: false }, // liquidity token program
    { pubkey: INSTRUCTIONS_SYSVAR,              isSigner: false, isWritable: false },
    { pubkey: obligationFarmUserState,          isSigner: false, isWritable: true  },
    { pubkey: args.reserveFarmState,            isSigner: false, isWritable: true  },
    { pubkey: FARMS,                            isSigner: false, isWritable: false },
  ];

  const data = Buffer.alloc(8 + 8);
  DISC_DEPOSIT_V2.copy(data, 0);
  data.writeBigUInt64LE(args.amountIn, 8);

  return new TransactionInstruction({ programId: KLEND, keys, data });
}
