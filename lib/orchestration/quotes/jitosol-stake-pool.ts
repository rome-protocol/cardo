// JitoSOL stake-pool exchange rate quote.
//
// SPL stake-pool stores `total_lamports` and `pool_token_supply` in the pool
// struct. The deposit-SOL rate is:
//   pool_tokens_out = lamports_in × pool_token_supply / total_lamports
//   (modulo the per-deposit fee and epoch-fee — for now we report the
//    pre-fee rate and warn).
//
// The withdraw-SOL rate (sell JitoSOL → SOL via stake-pool) does NOT exist
// for instant withdrawals on Jito (Jito uses delayed unstake). For the arb
// "buy JitoSOL via stake-pool, sell on DEX" we only need the deposit rate.
//
// SPL stake-pool layout offsets (pool struct):
//   0    discriminator (1B)
//   ... (account_type)
//   137  total_lamports (u64) ← we want this
//   145  pool_token_supply (u64)
// The exact offsets vary slightly across stake-pool versions; we read the
// pool's onchain data and pull from documented offsets.
//
// Reference: https://github.com/solana-labs/solana-program-library/blob/master/stake-pool/program/src/state.rs

import { Connection, PublicKey } from '@solana/web3.js';

// JitoSOL stake pool (verified mainnet)
export const JITOSOL_POOL = new PublicKey('Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb');

export type StakePoolRate = {
  pool: string;
  totalLamports: bigint;
  poolTokenSupply: bigint;
  /// pool_tokens per lamport, scaled by 10^18 for precision
  rateScaled: bigint;
  /// Human: 1 SOL → ~rateHuman JitoSOL (pre-fee)
  rateHuman: number;
};

export async function readJitoSolRate(conn: Connection): Promise<StakePoolRate> {
  const acct = await conn.getAccountInfo(JITOSOL_POOL);
  if (!acct) throw new Error('JitoSOL pool not found');
  const data = acct.data;

  // SPL stake-pool struct layout — see solana-program-library/stake-pool/program/src/state.rs
  // Fields up to total_lamports:
  //   account_type        u8       @ 0   (1)
  //   manager             Pubkey   @ 1   (32)
  //   staker              Pubkey   @ 33  (32)
  //   stake_deposit_authority Pubkey @ 65 (32)
  //   stake_withdraw_bump u8       @ 97  (1)
  //   validator_list      Pubkey   @ 98  (32)
  //   reserve_stake       Pubkey   @ 130 (32)
  //   pool_mint           Pubkey   @ 162 (32)
  //   manager_fee_account Pubkey   @ 194 (32)
  //   token_program_id    Pubkey   @ 226 (32)
  //   total_lamports      u64      @ 258
  //   pool_token_supply   u64      @ 266
  //   ...
  const totalLamports = data.readBigUInt64LE(258);
  const poolTokenSupply = data.readBigUInt64LE(266);

  // rate = pool_tokens_per_lamport
  // = pool_token_supply / total_lamports
  // Compute scaled to 10^18 for precision
  const SCALE = 10n ** 18n;
  const rateScaled = (poolTokenSupply * SCALE) / totalLamports;
  const rateHuman = Number(rateScaled) / 1e18;

  return {
    pool: JITOSOL_POOL.toBase58(),
    totalLamports,
    poolTokenSupply,
    rateScaled,
    rateHuman,
  };
}

/// Quote: deposit `lamports` SOL → JitoSOL (pre-fee).
export async function quoteJitoSolDeposit(args: {
  conn: Connection;
  lamports: bigint;
}): Promise<{ jitoSolOut: bigint; rateHuman: number; note: string }> {
  const rate = await readJitoSolRate(args.conn);
  // Deposit fee on Jito stake pool is 0% currently (epoch fee), but conservatively
  // assume up to 10bps. Actual on-chain ix returns the exact post-fee output.
  const jitoSolOut = (args.lamports * rate.poolTokenSupply) / rate.totalLamports;
  return {
    jitoSolOut,
    rateHuman: rate.rateHuman,
    note: `pool rate ${rate.rateHuman.toFixed(8)} jitoSOL/SOL; pre-fee`,
  };
}
