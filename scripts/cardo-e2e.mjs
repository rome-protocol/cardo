// Cardo orchestrator E2E test runner.
//
// Exercises the full API path against a real keypair:
//   /api/orchestrate (analyze)
//   /api/orchestrate/build (single-tx build)
//   /api/orchestrate/build-yield (yield two-popup)
//   /api/orchestrate/build-compose-step (compose iteration)
//   /api/orchestrate/relay (sendRawTransaction + confirm)
//
// Uses orchestrator keypair as a stand-in for the user wallet, so we
// can run the full sign-and-submit path without Phantom in the loop.
//
// Tests:
//   1. Slippage: build with 10bps vs 200bps, verify minOut differs
//   2. Stake: live execute SOL → JupSOL (small amount)
//   3. Yield: live execute USDC → Kamino supply (small amount)
//   4. Compose: live execute SOL → USDC → Kamino in sequence

import fs from 'node:fs';
import path from 'node:path';
import {
  Connection,
  Keypair,
  Transaction,
  VersionedTransaction,
} from '@solana/web3.js';

const HOST = process.env.CARDO_HOST ?? 'http://localhost:3030';
const KEY_PATH =
  process.env.CARDO_TEST_KEYPAIR ??
  path.join(
    process.env.HOME ?? '',
    'rome/.secrets/cardo-mainnet/orchestrator-v1.key',
  );
// RPC for the test runner. Reads MAINNET_RPC (or the first entry of
// MAINNET_RPCS) from env so we never hardcode a key in source. Falls
// back to the public Solana endpoint if neither is set.
const RPC = (
  process.env.MAINNET_RPC ??
  process.env.MAINNET_RPCS ??
  'https://api.mainnet-beta.solana.com'
)
  .split(',')[0]
  .trim();

const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(KEY_PATH).toString())));
const conn = new Connection(RPC, 'confirmed');
const userPubkey = payer.publicKey.toBase58();

console.log(`Test wallet: ${userPubkey}`);
console.log('');

async function api(path, body) {
  const r = await fetch(`${HOST}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  return { ok: r.ok, status: r.status, ...j };
}

async function signAndRelay(txWire) {
  const buf = Buffer.from(txWire.b64, 'base64');
  let tx;
  if (txWire.kind === 'v0') {
    tx = VersionedTransaction.deserialize(buf);
    tx.sign([payer]);
  } else {
    tx = Transaction.from(buf);
    tx.partialSign(payer);
  }
  const signed =
    tx instanceof VersionedTransaction
      ? Buffer.from(tx.serialize())
      : tx.serialize();
  const relayed = await api('/api/orchestrate/relay', {
    tx: { kind: txWire.kind, b64: signed.toString('base64') },
  });
  return relayed;
}

async function test1Slippage() {
  console.log('━━━ TEST 1: Slippage flow-through ━━━');
  const tight = await api('/api/orchestrate/build', {
    intent: { kind: 'swap', params: { amountInSol: 0.001 } },
    userPubkey,
    inputMint: 'So11111111111111111111111111111111111111112',
    outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    slippageBps: 10,
  });
  const loose = await api('/api/orchestrate/build', {
    intent: { kind: 'swap', params: { amountInSol: 0.001 } },
    userPubkey,
    inputMint: 'So11111111111111111111111111111111111111112',
    outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    slippageBps: 200,
  });
  if (!tight.ok || !loose.ok) {
    console.log(`  FAIL — tight=${tight.ok} loose=${loose.ok}`);
    if (!tight.ok) console.log('  tight error:', tight.error);
    if (!loose.ok) console.log('  loose error:', loose.error);
    return false;
  }
  const tightMin = BigInt(tight.quote.otherAmountThreshold);
  const looseMin = BigInt(loose.quote.otherAmountThreshold);
  console.log(`  tight (10bps) minOut: ${tightMin}`);
  console.log(`  loose (200bps) minOut: ${looseMin}`);
  // Tight slippage should give HIGHER minOut threshold (less tolerance for slippage)
  const pass = tightMin > looseMin;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}: tight minOut (${tightMin}) > loose minOut (${looseMin}) = ${pass}`);
  return pass;
}

async function test2Stake() {
  console.log('\n━━━ TEST 2: Stake live execute SOL → JupSOL (0.001 SOL) ━━━');
  const built = await api('/api/orchestrate/build', {
    intent: { kind: 'stake', params: { amountInSol: 0.001 } },
    userPubkey,
    inputMint: 'So11111111111111111111111111111111111111112',
    outputMint: 'jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v',
    slippageBps: 50,
  });
  if (!built.ok) {
    console.log('  build FAIL:', built.error);
    return false;
  }
  console.log(`  build OK: ${built.txSize} bytes, sim ${built.simUnitsConsumed} CU, route ${built.quote.route}`);
  console.log(`  expected output: ${built.quote.outAmount} JupSOL raw`);

  const before = await conn.getBalance(payer.publicKey, 'confirmed');
  const result = await signAndRelay(built.tx);
  if (result.status !== 'Confirmed') {
    console.log(`  execute FAIL: ${result.status} — ${result.error ?? 'unknown'}`);
    return false;
  }
  console.log(`  ✓ landed: ${result.txSig}`);
  console.log(`     ${result.txUrl}`);
  const after = await conn.getBalance(payer.publicKey, 'confirmed');
  console.log(`  SOL delta: ${(after - before) / 1e9}`);
  return true;
}

async function test3Yield() {
  console.log('\n━━━ TEST 3: Yield live execute 0.05 USDC → Kamino ━━━');
  const built = await api('/api/orchestrate/build-yield', {
    intent: { kind: 'yield', params: { amountInUsdc: 0.05 } },
    userPubkey,
    amountInUsdc: 0.05,
  });
  if (!built.ok) {
    console.log('  build FAIL:', built.error);
    return false;
  }
  console.log(`  setupRequired: ${built.setupRequired}`);
  console.log(`  steps: ${built.steps.length}`);
  for (const [i, step] of built.steps.entries()) {
    console.log(`  ▸ ${step.label}`);
    const result = await signAndRelay(step);
    if (result.status !== 'Confirmed') {
      console.log(`     FAIL: ${result.status} — ${result.error ?? 'unknown'}`);
      return false;
    }
    console.log(`     ✓ landed: ${result.txSig}`);
  }
  console.log('  ✓ yield flow complete');
  return true;
}

async function test4Compose() {
  console.log('\n━━━ TEST 4: Compose execute swap → yield ━━━');
  // Build the compose intent in the shape the AI would produce
  const intent = {
    kind: 'compose',
    raw: 'swap 0.001 SOL to USDC then deposit on Kamino',
    params: {
      steps: [
        {
          kind: 'swap',
          summary: 'swap 0.001 SOL → USDC',
          params: {
            amountInSol: 0.001,
            inputMint: 'So11111111111111111111111111111111111111112',
            outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          },
        },
        {
          kind: 'yield',
          summary: 'deposit USDC on Kamino',
          params: { amountInUsdc: 0.08, mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
        },
      ],
    },
    preference: 'auto',
    confidence: 0.95,
    summary: 'swap then yield',
  };
  for (let i = 0; i < intent.params.steps.length; i++) {
    console.log(`  ▸ Step ${i + 1}/${intent.params.steps.length}: ${intent.params.steps[i].summary}`);
    const built = await api('/api/orchestrate/build-compose-step', {
      intent,
      stepIndex: i,
      userPubkey,
      slippageBps: 50,
    });
    if (!built.ok) {
      console.log(`     build FAIL: ${built.error}`);
      return false;
    }
    // Server now returns txs[] (1 or more — yield-with-first-time-Kamino
    // setup returns 2: setup tx + deposit tx).
    const txs = built.txs;
    console.log(`     built OK (${txs.length} sub-tx${txs.length > 1 ? 's' : ''})`);
    for (let j = 0; j < txs.length; j++) {
      const sub = txs[j];
      const tag = txs.length > 1 ? `[${j + 1}/${txs.length}]` : '';
      const result = await signAndRelay(sub);
      if (result.status !== 'Confirmed') {
        console.log(`     execute FAIL${tag}: ${result.status} — ${result.error ?? 'unknown'}`);
        return false;
      }
      console.log(`     ✓ landed${tag}: ${result.txSig}`);
    }
  }
  console.log('  ✓ compose flow complete');
  return true;
}

async function main() {
  const pickTest = process.env.TEST ?? 'all';
  const results = {};

  if (pickTest === 'all' || pickTest === '1') {
    results.slippage = await test1Slippage();
  }
  if (pickTest === 'all' || pickTest === '2') {
    results.stake = await test2Stake();
  }
  if (pickTest === 'all' || pickTest === '3') {
    results.yield_ = await test3Yield();
  }
  if (pickTest === 'all' || pickTest === '4') {
    results.compose = await test4Compose();
  }

  console.log('\n━━━ SUMMARY ━━━');
  for (const [k, v] of Object.entries(results)) {
    console.log(`  ${k.padEnd(10)}  ${v ? '✓ PASS' : '✗ FAIL'}`);
  }
  const allPass = Object.values(results).every(Boolean);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  console.error('threw:', e);
  process.exit(1);
});
