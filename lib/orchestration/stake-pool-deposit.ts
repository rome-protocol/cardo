// Solana-native SPL stake-pool DepositSol instruction.
// Mirrors cardo/lib/stake-pool-instructions.ts:buildDepositSolInvoke,
// but produces a TransactionInstruction signed by a regular Solana keypair
// (the stand-in for what would be the user's Rome PDA in production Cardo).

import { PublicKey, TransactionInstruction, SystemProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { solanaProgramId } from '../solana-programs';

const SPL_STAKE_POOL_PROGRAM = new PublicKey(solanaProgramId('stakePool'));
const STAKE_POOL_TAG_DEPOSIT_SOL = 14;
const WITHDRAW_AUTHORITY_SEED = Buffer.from('withdraw');

/// PDA([stake_pool, "withdraw"], SPL_STAKE_POOL_PROGRAM)
export function deriveStakePoolWithdrawAuthority(stakePool: PublicKey): PublicKey {
  const [authority] = PublicKey.findProgramAddressSync(
    [stakePool.toBuffer(), WITHDRAW_AUTHORITY_SEED],
    SPL_STAKE_POOL_PROGRAM,
  );
  return authority;
}

export type StakePoolDepositArgs = {
  user: PublicKey;
  stakePool: PublicKey;
  reserveStake: PublicKey;
  poolMint: PublicKey;
  managerFeeAccount: PublicKey;
  referralFeeAccount?: PublicKey; // defaults to managerFeeAccount
  amountIn: bigint;
};

export function buildStakePoolDepositSolIx(args: StakePoolDepositArgs): TransactionInstruction {
  const withdrawAuthority = deriveStakePoolWithdrawAuthority(args.stakePool);
  const userPoolAta = getAssociatedTokenAddressSync(args.poolMint, args.user, true);

  const keys = [
    { pubkey: args.stakePool,        isSigner: false, isWritable: true  },
    { pubkey: withdrawAuthority,     isSigner: false, isWritable: false },
    { pubkey: args.reserveStake,     isSigner: false, isWritable: true  },
    { pubkey: args.user,             isSigner: true,  isWritable: true  }, // lamports source
    { pubkey: userPoolAta,           isSigner: false, isWritable: true  }, // pool tokens dest
    { pubkey: args.managerFeeAccount, isSigner: false, isWritable: true  },
    { pubkey: args.referralFeeAccount ?? args.managerFeeAccount, isSigner: false, isWritable: true },
    { pubkey: args.poolMint,         isSigner: false, isWritable: true  },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID,      isSigner: false, isWritable: false },
  ];

  const data = Buffer.alloc(1 + 8);
  data.writeUInt8(STAKE_POOL_TAG_DEPOSIT_SOL, 0);
  data.writeBigUInt64LE(args.amountIn, 1);

  return new TransactionInstruction({ programId: SPL_STAKE_POOL_PROGRAM, keys, data });
}
