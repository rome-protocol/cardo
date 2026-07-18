// wrap-sol.mjs — wrap a portion of native SOL into WSOL for the payer.
// Idempotent: creates the WSOL ATA if missing, transfers lamports in, syncNative.

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
  getAccount,
} from '@solana/spl-token';
import fs from 'node:fs';
import os from 'node:os';

const RPC = 'https://api.devnet.solana.com';
const WRAP_LAMPORTS = Number(process.env.WRAP_LAMPORTS || 50_000_000); // default 0.05 SOL

const keyData = JSON.parse(
  fs.readFileSync(os.homedir() + '/.rome-rome-solana-payer.json', 'utf8'),
);
const payer = Keypair.fromSecretKey(new Uint8Array(keyData));
console.log('payer:', payer.publicKey.toBase58());

const conn = new Connection(RPC, 'confirmed');
const balBefore = await conn.getBalance(payer.publicKey);
console.log('payer SOL before:', balBefore / LAMPORTS_PER_SOL);

const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, payer.publicKey);
console.log('WSOL ATA:', wsolAta.toBase58());

const ataInfo = await conn.getAccountInfo(wsolAta);
const ixs = [];
if (!ataInfo) {
  console.log('  ATA missing, creating...');
  ixs.push(
    createAssociatedTokenAccountInstruction(
      payer.publicKey,
      wsolAta,
      payer.publicKey,
      NATIVE_MINT,
    ),
  );
}
ixs.push(
  SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: wsolAta,
    lamports: WRAP_LAMPORTS,
  }),
);
ixs.push(createSyncNativeInstruction(wsolAta));

const tx = new Transaction().add(...ixs);
const sig = await sendAndConfirmTransaction(conn, tx, [payer], {
  commitment: 'confirmed',
});
console.log('wrap tx:', sig);

const wsolAcc = await getAccount(conn, wsolAta);
console.log('WSOL balance after:', Number(wsolAcc.amount) / 1e9, 'WSOL');
console.log('payer SOL after:', (await conn.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL);
