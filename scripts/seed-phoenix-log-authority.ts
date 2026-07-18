// Seed the Phoenix log-authority PDA with rent-exempt lamports so it
// exists as a System-owned account on devnet.
//
// Why this is needed:
//
// Phoenix's `Swap` ix references `log_authority` (a PDA derived from
// `["log"]` against the Phoenix program). On real Solana, Phoenix
// invoke_signed's that PDA inside the tx; the runtime synthesizes an
// empty AccountInfo for missing accounts so this works fine — the
// account never needs to be created.
//
// Rome's emulator (Mollusk-backed) is stricter: it builds its account
// list from `getAccountInfo` reads and rejects unknown keys with
// `account not found: <pubkey>`. So our smoke and end-to-end-via-CPI
// flows fail at the loader stage.
//
// Fix: transfer 0.001 SOL to the log_authority pubkey via SystemProgram.
// That makes it a real System-owned 0-byte account. Phoenix's
// `assert_with_msg(authority.key == &phoenix_log_authority::id())`
// only checks the pubkey — not owner, not data — so this is safe.
//
// Run:
//   npx tsx scripts/seed-phoenix-log-authority.ts

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import * as fs from 'fs';

const RPC_URL = 'https://api.devnet.solana.com';
const TREASURY_KEYPAIR_PATH =
  '$HOME/rome/.secrets/e2e/treasury-solana.json';
const LOG_AUTHORITY = new PublicKey(
  '7aDTsspkQNGKmrexAN7FLx9oxU3iPczSSvHNggyuqYkR',
);
const SEED_LAMPORTS = 0.001 * LAMPORTS_PER_SOL;

async function main() {
  const conn = new Connection(RPC_URL, 'confirmed');
  const treasury = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(TREASURY_KEYPAIR_PATH, 'utf8'))),
  );
  console.log(`treasury: ${treasury.publicKey.toBase58()}`);

  const existing = await conn.getAccountInfo(LOG_AUTHORITY, 'confirmed');
  if (existing) {
    console.log(
      `log_authority already exists: lamports=${existing.lamports}, owner=${existing.owner.toBase58()}`,
    );
    return;
  }

  console.log(`seeding ${LOG_AUTHORITY.toBase58()} with ${SEED_LAMPORTS / LAMPORTS_PER_SOL} SOL…`);
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: treasury.publicKey,
      toPubkey: LOG_AUTHORITY,
      lamports: SEED_LAMPORTS,
    }),
  );
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = treasury.publicKey;
  tx.sign(treasury);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  console.log(`  sig: ${sig}`);
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  const after = await conn.getAccountInfo(LOG_AUTHORITY, 'confirmed');
  console.log(
    `  done. log_authority now: lamports=${after?.lamports}, owner=${after?.owner.toBase58()}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
