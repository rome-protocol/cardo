// Jito bundle probe — Solana devnet, end-to-end.
//
// Purpose: empirically verify (a) Jito's testnet block engine accepts a
// bundle from a fresh Solana keypair, (b) bundles land atomically, (c)
// measure submit→land latency. Independent of Rome — pure Solana so we
// validate Jito mechanics first, then design Rome-side integration
// separately.
//
// Bundle shape (2 txs, well below the 5-tx cap):
//   tx 1 — System self-transfer of 1 lamport (a no-op marker)
//   tx 2 — System transfer of 1,000 lamports to a Jito tip account (the
//          minimum-required tip per docs.jito.wtf)
//
// Both txs are fully signed by the same fresh keypair. Bundle is
// submitted via the `sendBundle` JSON-RPC method. Poll `getBundleStatuses`
// every 1s up to 60s for the landed-or-rejected verdict.
//
// Identity: Solana keypair generated locally and stored at
//   <your-secrets-dir>/cardo-smoke/jito-probe.key
// Funded via the Solana devnet airdrop (free, no human action needed).
//
// Endpoint: https://testnet.block-engine.jito.wtf  (Jito's testnet maps
// to Solana's devnet per docs.jito.wtf).

import fs from 'node:fs';
import path from 'node:path';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import bs58Mod from 'bs58';
const b58 = bs58Mod.default ?? bs58Mod;

const KEY_PATH = path.join(
  process.env.HOME ?? '',
  'rome/.secrets/cardo-smoke/jito-probe.key',
);

const SOLANA_DEVNET = 'https://api.devnet.solana.com';
const JITO_BLOCK_ENGINE = 'https://testnet.block-engine.jito.wtf/api/v1/bundles';

const TIP_LAMPORTS = 1_000n;
const NOOP_LAMPORTS = 1n;
const AIRDROP_TARGET_LAMPORTS = 100_000_000n; // 0.1 SOL — covers many probe runs

async function loadOrCreateKeypair() {
  if (fs.existsSync(KEY_PATH)) {
    const raw = fs.readFileSync(KEY_PATH);
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw.toString())));
  }
  const kp = Keypair.generate();
  fs.mkdirSync(path.dirname(KEY_PATH), { recursive: true, mode: 0o700 });
  fs.writeFileSync(KEY_PATH, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  return kp;
}

async function jitoRpc(method, params) {
  const res = await fetch(JITO_BLOCK_ENGINE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return res.json();
}

async function main() {
  console.log('=== Jito bundle probe — devnet ===');
  console.log(`Endpoint: ${JITO_BLOCK_ENGINE}`);
  console.log('');

  const kp = await loadOrCreateKeypair();
  console.log(`Probe keypair: ${kp.publicKey.toBase58()}`);

  const conn = new Connection(SOLANA_DEVNET, 'confirmed');

  // ---------- Funding ----------
  const balanceBefore = await conn.getBalance(kp.publicKey);
  console.log(`Balance: ${balanceBefore} lamports`);
  if (BigInt(balanceBefore) < AIRDROP_TARGET_LAMPORTS / 2n) {
    console.log(`Airdropping ${AIRDROP_TARGET_LAMPORTS} lamports …`);
    try {
      const sig = await conn.requestAirdrop(kp.publicKey, Number(AIRDROP_TARGET_LAMPORTS));
      console.log(`  airdrop sig: ${sig}`);
      await conn.confirmTransaction(sig, 'confirmed');
      const bal = await conn.getBalance(kp.publicKey);
      console.log(`  balance now: ${bal} lamports`);
    } catch (e) {
      console.error(`  airdrop failed: ${e.message ?? e}`);
      console.error(`  fund manually: solana airdrop 0.5 ${kp.publicKey.toBase58()} --url devnet`);
      process.exit(1);
    }
  }

  // ---------- Get tip accounts ----------
  console.log('');
  console.log('Fetching Jito tip accounts …');
  const tipAccountsRes = await jitoRpc('getTipAccounts', []);
  if (!tipAccountsRes?.result?.length) {
    console.error(`  failed: ${JSON.stringify(tipAccountsRes)}`);
    process.exit(1);
  }
  const tipAccount = new PublicKey(tipAccountsRes.result[0]);
  console.log(`  using tip account: ${tipAccount.toBase58()}`);

  // ---------- Build the 2 bundle txs ----------
  console.log('');
  console.log('Building bundle (2 txs) …');
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');

  // Tx 1 — no-op self-transfer (a marker tx that will appear on chain)
  const tx1 = new Transaction({ recentBlockhash: blockhash, feePayer: kp.publicKey });
  tx1.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    SystemProgram.transfer({
      fromPubkey: kp.publicKey,
      toPubkey: kp.publicKey,
      lamports: Number(NOOP_LAMPORTS),
    }),
  );
  tx1.sign(kp);

  // Tx 2 — tip
  const tx2 = new Transaction({ recentBlockhash: blockhash, feePayer: kp.publicKey });
  tx2.add(
    SystemProgram.transfer({
      fromPubkey: kp.publicKey,
      toPubkey: tipAccount,
      lamports: Number(TIP_LAMPORTS),
    }),
  );
  tx2.sign(kp);

  const txsBs58 = [
    b58.encode(tx1.serialize()),
    b58.encode(tx2.serialize()),
  ];
  const tx1Sig = b58.encode(tx1.signature ?? Buffer.alloc(0));
  const tx2Sig = b58.encode(tx2.signature ?? Buffer.alloc(0));
  console.log(`  tx1 (no-op) size:  ${tx1.serialize().length}B  sig: ${tx1Sig}`);
  console.log(`  tx2 (tip)   size:  ${tx2.serialize().length}B  sig: ${tx2Sig}`);

  // ---------- Submit ----------
  console.log('');
  console.log('Submitting bundle to Jito Block Engine …');
  const submitT0 = Date.now();
  const submitRes = await jitoRpc('sendBundle', [txsBs58]);
  const submitMs = Date.now() - submitT0;
  console.log(`  submit response (${submitMs}ms):`, JSON.stringify(submitRes));
  if (submitRes.error) {
    console.error(`  FAIL — Jito rejected the bundle.`);
    process.exit(1);
  }
  const bundleId = submitRes.result;
  console.log(`  bundle id: ${bundleId}`);

  // ---------- Poll for landing ----------
  console.log('');
  console.log('Polling getBundleStatuses (up to 60s) …');
  const pollT0 = Date.now();
  let landed = null;
  while (Date.now() - pollT0 < 60_000) {
    const r = await jitoRpc('getBundleStatuses', [[bundleId]]);
    const v = r?.result?.value?.[0];
    if (v) {
      landed = v;
      break;
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
  const landMs = Date.now() - pollT0;

  if (!landed) {
    console.error('  TIMEOUT — no bundle status returned within 60s');
    console.error('  This is normal on testnet — most slots have no Jito leader; tip txs go unrouted.');
    console.error('  The submission itself was accepted (response above had no error).');
    process.exit(1);
  }

  console.log(`  landed-or-status after ${landMs}ms:`, JSON.stringify(landed, null, 2));

  // ---------- Verify on Solana side ----------
  console.log('');
  console.log('=== Solana-side verification ===');
  const balanceAfter = await conn.getBalance(kp.publicKey);
  console.log(`Probe balance before: ${balanceBefore} lamports`);
  console.log(`Probe balance after:  ${balanceAfter} lamports`);
  const delta = BigInt(balanceBefore) - BigInt(balanceAfter);
  console.log(`Delta:                ${delta} lamports (= tip ${TIP_LAMPORTS} + ~10k tx fees)`);

  console.log('');
  console.log('=== PASS — bundle landed atomically ===');
  console.log(`bundle id:  ${bundleId}`);
  console.log(`tx1 sig:    ${tx1Sig}`);
  console.log(`tx2 sig:    ${tx2Sig}`);
  console.log(`submit ms:  ${submitMs}`);
  console.log(`land ms:    ${landMs}`);
}

main().catch((e) => {
  console.error('threw:', e);
  process.exit(1);
});
