// Mint Drift devnet USDC (`8zGuJQqw…`) into a user's PDA ATA via Drift's
// `token_faucet` program (`V4v1mQiAdLz…`). Anyone can call mintToUser.
//
// Usage: node scripts/faucet-drift-usdc.mjs <user_pda_bs58> [amount_usdc=100]
//
// Verified accounts struct (drift-labs/protocol-v2:programs/token_faucet):
//   #[derive(Accounts)] pub struct MintToUser<'info> {
//     pub faucet_config: Box<Account<'info, FaucetConfig>>,    // PDA(["faucet_config", mint])
//     #[account(mut)] pub mint_account: Box<Account<'info, Mint>>,
//     #[account(mut)] pub user_token_account: Box<Account<'info, TokenAccount>>,
//     pub mint_authority: AccountInfo<'info>,                  // PDA(["mint_authority", mint])
//     pub token_program: Program<'info, Token>,
//   }
//
// Discriminator: sha256("global:mintToUser")[..8] (camelCase).

import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { sha256 } from '@noble/hashes/sha256';
import fs from 'node:fs';

const FAUCET_PROGRAM = new PublicKey('V4v1mQiAdLz4qwckEb45WqHYceYizoib39cDBHSWfaB');
const MINT = new PublicKey('8zGuJQqwhZafTah7Uc7Z4tXRnguqkn5KLFAP8oV6PHe2');

const userPdaArg = process.argv[2] ?? 'DDheSm1Q2bJMFw5yDqEekmbzjLjLTRiE2dqsKU4Pep81';
const amountUsdc = Number(process.argv[3] ?? 100);
const amount = BigInt(Math.floor(amountUsdc * 1_000_000));

const userPda = new PublicKey(userPdaArg);
const ata = getAssociatedTokenAddressSync(MINT, userPda, true);

// Derive faucet_config and mint_authority PDAs
const [faucetConfig] = PublicKey.findProgramAddressSync(
  [Buffer.from('faucet_config'), MINT.toBuffer()], FAUCET_PROGRAM,
);
const [mintAuthority] = PublicKey.findProgramAddressSync(
  [Buffer.from('mint_authority'), MINT.toBuffer()], FAUCET_PROGRAM,
);

console.log('user PDA:        ', userPda.toBase58());
console.log('ATA:             ', ata.toBase58());
console.log('faucet_config:   ', faucetConfig.toBase58());
console.log('mint_authority:  ', mintAuthority.toBase58());
console.log('amount:          ', amountUsdc, 'USDC');

const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(process.env.HOME + '/.rome-rome-solana-payer.json', 'utf8'))),
);
console.log('payer:           ', payer.publicKey.toBase58());

const conn = new Connection('https://api.devnet.solana.com', 'confirmed');

// IDL fn name: try snake_case (older Anchor); camelCase failed with
// InstructionFallbackNotFound (101).
const disc = sha256(new TextEncoder().encode('global:mint_to_user')).slice(0, 8);
const data = Buffer.alloc(16);
Buffer.from(disc).copy(data, 0);
data.writeBigUInt64LE(amount, 8);

const mintToUserIx = new TransactionInstruction({
  programId: FAUCET_PROGRAM,
  keys: [
    { pubkey: faucetConfig,     isSigner: false, isWritable: false },
    { pubkey: MINT,             isSigner: false, isWritable: true  },
    { pubkey: ata,              isSigner: false, isWritable: true  },
    { pubkey: mintAuthority,    isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ],
  data,
});

const ataIx = createAssociatedTokenAccountIdempotentInstruction(
  payer.publicKey, ata, userPda, MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
);

console.log('tx1: ATA idempotent...');
const sig1 = await sendAndConfirmTransaction(conn, new Transaction().add(ataIx), [payer]);
console.log('  sig1:', sig1);

console.log('tx2: mintToUser...');
const sig = await sendAndConfirmTransaction(conn, new Transaction().add(mintToUserIx), [payer]);
console.log('  sig:', sig);

const after = await conn.getTokenAccountBalance(ata);
console.log('ATA balance:', after.value.uiAmountString, 'USDC');
