// One-shot: externally create an SPL ATA owned by a Cardo user's Rome
// PDA. Funder is the e2e Solana treasury (rents come out of its balance).
//
// Why: Rome's strict-mode CPI emulator rejects a writable destination
// account that doesn't yet exist — even when the inner ix is the ATA
// program's CreateIdempotent (which would normally create the account
// itself). For mints that don't have a Rome ERC20-SPL wrapper (e.g.
// mSOL), the only path to bootstrap the user's ATA is to create it
// outside Rome via a direct Solana tx. The ATA program lets any signer
// pay rent for any (owner, mint) pair, and the resulting ATA is owned
// by `owner` regardless of who funded it.
//
// Run:
//   USER_EVM_ADDR=0x3403e0… MINT_BS58=mSoLzY… \
//     node --import tsx scripts/create-user-ata.ts
//
// Prints the resulting ATA pubkey + tx sig. Idempotent — safe to re-run.

import fs from 'node:fs';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
  bytes32ToPublicKey,
  deriveAta,
  deriveRomeUserPda,
  pubkeyBs58ToBytes32,
} from '../lib/solana-pda.ts';

const USER_EVM = process.env.USER_EVM_ADDR;
const MINT_BS58 = process.env.MINT_BS58;
const TREASURY_KP = process.env.TREASURY_KEYPAIR
  || '$HOME/rome/.secrets/e2e/treasury-solana.json';
const RPC = process.env.SOLANA_RPC || 'https://api.devnet.solana.com';

if (!USER_EVM || !MINT_BS58) {
  console.error('USER_EVM_ADDR + MINT_BS58 env vars are required');
  process.exit(2);
}

async function main() {
  const treasury = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(TREASURY_KP, 'utf8'))),
  );
  console.log(`[ata] funder: ${treasury.publicKey.toBase58()}`);

  const userPda = deriveRomeUserPda(USER_EVM!);
  const userPdaPk = bytes32ToPublicKey(userPda);
  const mintHex = pubkeyBs58ToBytes32(MINT_BS58!);
  const ataHex = deriveAta(userPda, mintHex);
  const ataPk = bytes32ToPublicKey(ataHex);

  console.log(`[ata] owner (user PDA): ${userPdaPk.toBase58()}`);
  console.log(`[ata] mint:             ${MINT_BS58}`);
  console.log(`[ata] target ATA:       ${ataPk.toBase58()}`);

  const conn = new Connection(RPC, 'confirmed');

  // Pre-flight — already exists?
  const pre = await conn.getAccountInfo(ataPk);
  if (pre) {
    console.log(`[ata] ✓ ATA already exists (lamports=${pre.lamports}, ${pre.data.length} bytes data) — nothing to do.`);
    return;
  }

  // Build CreateIdempotent ix manually so we don't pull in spl-token
  // helpers (keeps the script's dep surface minimal).
  const ix = new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: treasury.publicKey, isSigner: true, isWritable: true },
      { pubkey: ataPk, isSigner: false, isWritable: true },
      { pubkey: userPdaPk, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(MINT_BS58!), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]), // CreateIdempotent
  });

  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  const tx = new Transaction({
    feePayer: treasury.publicKey,
    recentBlockhash: blockhash,
  });
  tx.add(ix);
  tx.sign(treasury);

  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  console.log(`[ata] sent: ${sig}`);
  const conf = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight: (await conn.getBlockHeight()) + 100 }, 'confirmed');
  if (conf.value.err) {
    console.log(`[ata] ❌ confirmation error: ${JSON.stringify(conf.value.err)}`);
    process.exit(1);
  }

  const post = await conn.getAccountInfo(ataPk);
  console.log(`[ata] ✓ ATA created — lamports=${post?.lamports}, ${post?.data.length} bytes data`);
  console.log(`[ata] sig: ${sig}`);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
