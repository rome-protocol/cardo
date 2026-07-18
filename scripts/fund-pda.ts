// One-shot: fund a Solana PDA with rent-exempt SOL so it exists as a
// system-owned 0-byte account on devnet. This is a workaround for
// Rome's strict-mode CPI emulator, which rejects ANY referenced
// account (writable OR readonly) that doesn't have on-chain data —
// even purely-derived PDAs that programs use only as `invoke_signed`
// signing addresses.
//
// Cost: 890,880 lamports (~$0.000088) of treasury SOL, irreversibly
// committed to the PDA. invoke_signed math is unaffected — Solana's
// runtime checks `derived(seeds) == addr`, not the account's owner
// field, when validating PDA signing.
//
// Run:
//   PDA_BS58=2HFJMAkD… node --import tsx scripts/fund-pda.ts

import fs from 'node:fs';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';

const PDA_BS58 = process.env.PDA_BS58;
const TREASURY_KP = process.env.TREASURY_KEYPAIR
  || '$HOME/rome/.secrets/e2e/treasury-solana.json';
const RPC = process.env.SOLANA_RPC || 'https://api.devnet.solana.com';
const LAMPORTS = BigInt(process.env.LAMPORTS || '1000000');

if (!PDA_BS58) {
  console.error('PDA_BS58 env var required');
  process.exit(2);
}

async function main() {
  const treasury = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(TREASURY_KP, 'utf8'))),
  );
  const target = new PublicKey(PDA_BS58!);
  console.log(`[fund] funder: ${treasury.publicKey.toBase58()}`);
  console.log(`[fund] target: ${target.toBase58()}`);
  console.log(`[fund] amount: ${LAMPORTS} lamports (${Number(LAMPORTS) / 1e9} SOL)`);

  const conn = new Connection(RPC, 'confirmed');

  const pre = await conn.getAccountInfo(target);
  if (pre) {
    console.log(`[fund] ✓ already funded — lamports=${pre.lamports}, owner=${pre.owner.toBase58()}; nothing to do`);
    return;
  }

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: treasury.publicKey,
      toPubkey: target,
      lamports: Number(LAMPORTS),
    }),
  );
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  tx.feePayer = treasury.publicKey;
  tx.recentBlockhash = blockhash;
  tx.sign(treasury);
  const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  console.log(`[fund] sent: ${sig}`);
  const conf = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight: (await conn.getBlockHeight()) + 100 }, 'confirmed');
  if (conf.value.err) {
    console.log(`[fund] ❌ ${JSON.stringify(conf.value.err)}`);
    process.exit(1);
  }
  const post = await conn.getAccountInfo(target);
  console.log(`[fund] ✓ funded — lamports=${post?.lamports}, owner=${post?.owner.toBase58()}`);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
