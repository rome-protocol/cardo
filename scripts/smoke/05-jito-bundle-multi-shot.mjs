// Jito multi-shot bundle probe — measures testnet landing rate.
//
// Submits N small 2-tx bundles, polls each for landing, reports stats.
// Each bundle's tip uses a different tip account (round-robin) so
// auction selection has variety.

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

const KEY_PATH = path.join(process.env.HOME ?? '', 'rome/.secrets/cardo-smoke/jito-probe.key');
const SOLANA_DEVNET = 'https://api.devnet.solana.com';
const JITO_BLOCK_ENGINE = 'https://testnet.block-engine.jito.wtf/api/v1/bundles';

const N_SHOTS = 10;
const POLL_PER_SHOT_MS = 30_000;
const TIP_LAMPORTS = 10_000;          // 10x min — better landing odds

async function jitoRpc(method, params) {
  const res = await fetch(JITO_BLOCK_ENGINE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return res.json();
}

async function main() {
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(KEY_PATH).toString())));
  console.log(`probe keypair: ${kp.publicKey.toBase58()}`);

  const conn = new Connection(SOLANA_DEVNET, 'confirmed');
  const balance = await conn.getBalance(kp.publicKey);
  console.log(`balance: ${balance} lamports (${balance/1e9} SOL)`);

  const tipAccounts = (await jitoRpc('getTipAccounts', [])).result;
  console.log(`tip accounts available: ${tipAccounts.length}`);

  console.log(`\n=== Submitting ${N_SHOTS} bundles, polling each up to ${POLL_PER_SHOT_MS/1000}s ===\n`);

  const results = [];
  for (let i = 0; i < N_SHOTS; i++) {
    const tipAccount = new PublicKey(tipAccounts[i % tipAccounts.length]);
    const { blockhash } = await conn.getLatestBlockhash('confirmed');

    const tx1 = new Transaction({ recentBlockhash: blockhash, feePayer: kp.publicKey });
    tx1.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      // Self-transfer with a varying lamport amount so each tx is unique
      SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: kp.publicKey, lamports: i + 1 }),
    );
    tx1.sign(kp);

    const tx2 = new Transaction({ recentBlockhash: blockhash, feePayer: kp.publicKey });
    tx2.add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: tipAccount, lamports: TIP_LAMPORTS }));
    tx2.sign(kp);

    const txsBs58 = [b58.encode(tx1.serialize()), b58.encode(tx2.serialize())];
    const tx1Sig = b58.encode(tx1.signature);

    const submitT = Date.now();
    const sub = await jitoRpc('sendBundle', [txsBs58]);
    const submitMs = Date.now() - submitT;

    if (sub.error) {
      console.log(`shot ${i+1}: REJECTED in ${submitMs}ms — ${JSON.stringify(sub.error)}`);
      results.push({ i, status: 'rejected', submitMs, error: sub.error });
      continue;
    }

    const bundleId = sub.result;
    process.stdout.write(`shot ${i+1}: submitted in ${submitMs}ms (bundle ${bundleId.slice(0,8)}…) … `);

    // Poll Jito + check Solana getSignatureStatuses for tx1Sig (the no-op).
    // If the tx lands at all (via Jito or via leaked-to-mempool fallback) we'll see it.
    const pollT = Date.now();
    let landed = null;
    let viaSolana = false;
    while (Date.now() - pollT < POLL_PER_SHOT_MS) {
      const r = await jitoRpc('getBundleStatuses', [[bundleId]]);
      const v = r?.result?.value?.[0];
      if (v) { landed = v; break; }
      // Also poll Solana directly for the tx1 sig
      const stat = await conn.getSignatureStatuses([tx1Sig]);
      if (stat?.value?.[0]?.confirmationStatus) {
        viaSolana = true;
        landed = { confirmationStatus: stat.value[0].confirmationStatus, slot: stat.value[0].slot };
        break;
      }
      await new Promise(r => setTimeout(r, 1500));
    }
    const landMs = Date.now() - pollT;
    if (landed) {
      console.log(`LANDED ${viaSolana ? '(via Solana RPC fallback)' : '(via Jito)'} in ${landMs}ms`);
      results.push({ i, status: 'landed', submitMs, landMs, viaSolana, bundleId, tx1Sig });
    } else {
      console.log(`TIMEOUT after ${landMs}ms`);
      results.push({ i, status: 'timeout', submitMs, landMs, bundleId, tx1Sig });
    }
  }

  console.log(`\n=== Summary ===`);
  const landed = results.filter(r => r.status === 'landed');
  const timeout = results.filter(r => r.status === 'timeout');
  const rejected = results.filter(r => r.status === 'rejected');
  console.log(`landed:    ${landed.length}/${N_SHOTS}  (${landed.filter(r=>!r.viaSolana).length} via Jito, ${landed.filter(r=>r.viaSolana).length} via Solana RPC fallback)`);
  console.log(`timeout:   ${timeout.length}/${N_SHOTS}`);
  console.log(`rejected:  ${rejected.length}/${N_SHOTS}`);
  if (landed.length) {
    const submits = landed.map(r => r.submitMs);
    const lands = landed.map(r => r.landMs);
    console.log(`submit p50/p95: ${pct(submits, 0.5)}ms / ${pct(submits, 0.95)}ms`);
    console.log(`land   p50/p95: ${pct(lands, 0.5)}ms / ${pct(lands, 0.95)}ms`);
  }

  console.log(`\nLanded sigs (verify on https://explorer.solana.com/?cluster=devnet):`);
  for (const r of landed) console.log(`  ${r.tx1Sig}`);
}

function pct(arr, p) {
  const sorted = [...arr].sort((a,b)=>a-b);
  return sorted[Math.floor(sorted.length * p)] ?? '?';
}

main().catch(e => { console.error('threw:', e); process.exit(1); });
