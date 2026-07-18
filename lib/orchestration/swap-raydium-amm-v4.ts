// Solana-native Raydium AMM v4 swap_base_in instruction.
//
// Mirrors `cardo/lib/raydium-amm-instructions.ts:buildRaydiumAmmV4SwapBaseInInvoke`
// but produces a TransactionInstruction directly (using the user's Solana
// keypair as the signer/owner) instead of the {program, accounts, data}
// triple format Cardo's CPI precompile uses.
//
// Use case: orchestrator flows that submit directly to Solana (no Rome
// stack) — direct Solana submission only.

import {
  PublicKey,
  TransactionInstruction,
} from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { solanaProgramId } from '../solana-programs';

const SWAP_BASE_IN_TAG = 9;

export type RaydiumPoolDeps = {
  pool: PublicKey;
  authority: PublicKey;       // hardcoded `5Q544f…je4j1` for AMM v4
  ammOpenOrders: PublicKey;
  ammTargetOrders: PublicKey;
  poolCoinVault: PublicKey;
  poolPcVault: PublicKey;
  serumProgram: PublicKey;
  serumMarket: PublicKey;
  serumBids: PublicKey;
  serumAsks: PublicKey;
  serumEventQueue: PublicKey;
  serumCoinVault: PublicKey;
  serumPcVault: PublicKey;
  serumVaultSigner: PublicKey; // PDA derived from market + nonce
  coinMint: PublicKey;
  pcMint: PublicKey;
  tokenProgram: PublicKey;     // SPL Token classic
};

/**
 * Derive the Serum vault signer PDA.
 * Seeds: [marketAddress, nonce_u64_LE]
 * NOT findProgramAddress — uses createProgramAddress (no bump search).
 */
export function deriveSerumVaultSigner(
  market: PublicKey,
  vaultSignerNonce: bigint,
  serumProgram: PublicKey,
): PublicKey {
  const nonceBytes = Buffer.alloc(8);
  nonceBytes.writeBigUInt64LE(vaultSignerNonce, 0);
  return PublicKey.createProgramAddressSync(
    [market.toBuffer(), nonceBytes],
    serumProgram,
  );
}

/**
 * Build a Raydium AMM v4 swap_base_in instruction for direct Solana
 * submission (no Rome CPI wrapping).
 */
export function buildRaydiumSwapIx(args: {
  user: PublicKey;
  pool: RaydiumPoolDeps;
  /// `true` = user spends the coin side. `false` = user spends the pc side.
  inputIsCoin: boolean;
  amountIn: bigint;
  minimumAmountOut: bigint;
}): TransactionInstruction {
  const inputMint = args.inputIsCoin ? args.pool.coinMint : args.pool.pcMint;
  const outputMint = args.inputIsCoin ? args.pool.pcMint : args.pool.coinMint;
  const userSourceAta = getAssociatedTokenAddressSync(inputMint, args.user, true);
  const userDestAta = getAssociatedTokenAddressSync(outputMint, args.user, true);

  const keys = [
    { pubkey: args.pool.tokenProgram,    isSigner: false, isWritable: false },
    { pubkey: args.pool.pool,            isSigner: false, isWritable: true  },
    { pubkey: args.pool.authority,       isSigner: false, isWritable: false },
    { pubkey: args.pool.ammOpenOrders,   isSigner: false, isWritable: true  },
    { pubkey: args.pool.ammTargetOrders, isSigner: false, isWritable: true  },
    { pubkey: args.pool.poolCoinVault,   isSigner: false, isWritable: true  },
    { pubkey: args.pool.poolPcVault,     isSigner: false, isWritable: true  },
    { pubkey: args.pool.serumProgram,    isSigner: false, isWritable: false },
    { pubkey: args.pool.serumMarket,     isSigner: false, isWritable: true  },
    { pubkey: args.pool.serumBids,       isSigner: false, isWritable: true  },
    { pubkey: args.pool.serumAsks,       isSigner: false, isWritable: true  },
    { pubkey: args.pool.serumEventQueue, isSigner: false, isWritable: true  },
    { pubkey: args.pool.serumCoinVault,  isSigner: false, isWritable: true  },
    { pubkey: args.pool.serumPcVault,    isSigner: false, isWritable: true  },
    { pubkey: args.pool.serumVaultSigner,isSigner: false, isWritable: false },
    { pubkey: userSourceAta,             isSigner: false, isWritable: true  },
    { pubkey: userDestAta,               isSigner: false, isWritable: true  },
    { pubkey: args.user,                 isSigner: true,  isWritable: true  },
  ];

  const data = Buffer.alloc(1 + 8 + 8);
  data.writeUInt8(SWAP_BASE_IN_TAG, 0);
  data.writeBigUInt64LE(args.amountIn, 1);
  data.writeBigUInt64LE(args.minimumAmountOut, 9);

  return new TransactionInstruction({
    programId: new PublicKey(solanaProgramId('raydiumAmmV4')),
    keys,
    data,
  });
}
