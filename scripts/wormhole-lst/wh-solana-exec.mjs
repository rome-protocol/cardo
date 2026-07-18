// Wormhole Solana-side executor: verifySignatures -> postVaa -> then either
// createWrapped (AttestMeta VAA) or completeTransferWrapped (Transfer VAA).
// Usage: node wh-solana-exec.mjs <vaa-file.b64> attest|transfer [recipientAtaOwner]
//
// - Verify batches ship WITHOUT ComputeBudget prefix (secp sysvar-index
//   coupling — see rome-bridge-api src/wormhole/execute-receive-flow.ts).
// - Confirmation is polling-based (no WS dependency on the internal node).
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('$HOME/rome/rome-bridge-api/package.json');

const {
  Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram,
} = require('@solana/web3.js');
const {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
} = require('@solana/spl-token');
const { deserialize } = require('@wormhole-foundation/sdk-connect');
const tokenBridge = require('@wormhole-foundation/sdk-solana-tokenbridge');
const core = require('@wormhole-foundation/sdk-solana-core');

const RPC = 'https://api.devnet.solana.com/';
const TOKEN_BRIDGE = new PublicKey('DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe');
const CORE = new PublicKey('3u8hJUVTA4jH1wYAyUur7FFZVQ8H635K3tSHHF4ssjQ5');

const [vaaFile, mode, recipientOwnerB58] = process.argv.slice(2);
if (!vaaFile || !['attest', 'transfer'].includes(mode)) {
  console.error('usage: node wh-solana-exec.mjs <vaa.b64> attest|transfer [recipientAtaOwner]');
  process.exit(1);
}

const payer = Keypair.fromSecretKey(Buffer.from(JSON.parse(
  fs.readFileSync(`${process.env.HOME}/rome/.secrets/e2e/treasury-solana.json`, 'utf8'))));
const conn = new Connection(RPC, 'confirmed');

async function sendTx(ixs, { computeBudget = false, extraSigners = [] } = {}) {
  const tx = new Transaction();
  if (computeBudget) tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
  for (const ix of ixs) tx.add(ix);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer.publicKey;
  tx.sign(payer, ...extraSigners);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  // poll confirm (no WS)
  for (let i = 0; i < 60; i++) {
    const st = await conn.getSignatureStatuses([sig]);
    const s = st.value[0];
    if (s?.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(s.err)}`);
    if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return sig;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`tx ${sig} not confirmed after 120s`);
}

const vaaBytes = new Uint8Array(Buffer.from(fs.readFileSync(vaaFile, 'utf8').trim(), 'base64'));
const vaaType = mode === 'attest' ? 'TokenBridge:AttestMeta' : 'TokenBridge:Transfer';
const vaa = deserialize(vaaType, vaaBytes);
console.log(`VAA ${vaaFile}: type=${vaaType} emitterChain=${vaa.emitterChain} seq=${vaa.sequence}`);

// 1. verifySignatures — fresh signatureSet, pairs per tx, NO ComputeBudget
const signatureSet = Keypair.generate();
const verifyIxs = await core.utils.createVerifySignaturesInstructions(
  conn, CORE, payer.publicKey, vaa, signatureSet.publicKey);
for (let i = 0; i < verifyIxs.length; i += 2) {
  const sig = await sendTx(verifyIxs.slice(i, i + 2), { extraSigners: [signatureSet] });
  console.log(`verifySignatures batch ${i / 2 + 1}: ${sig}`);
}

// 2. postVaa
const postIx = core.utils.createPostVaaInstruction(conn, CORE, payer.publicKey, vaa, signatureSet.publicKey);
console.log('postVaa:', await sendTx([postIx], { computeBudget: true }));

// 3. final step
if (mode === 'attest') {
  const ix = tokenBridge.createCreateWrappedInstruction(conn, TOKEN_BRIDGE, CORE, payer.publicKey, vaa);
  console.log('createWrapped:', await sendTx([ix], { computeBudget: true }));
} else {
  // Transfer: ensure recipient ATA exists (owner passed in; ATA must equal VAA.to)
  const mintChain = Buffer.alloc(2); mintChain.writeUInt16BE(vaa.payload.token.chain === 'Sepolia' ? 10002 : vaa.payload.token.chain);
  // derive wrapped mint from VAA token
  const tokenAddr = Buffer.from(vaa.payload.token.address.toUint8Array());
  const [wrappedMint] = PublicKey.findProgramAddressSync(
    [Buffer.from('wrapped'), mintChain, tokenAddr], TOKEN_BRIDGE);
  const owner = new PublicKey(recipientOwnerB58);
  const ata = getAssociatedTokenAddressSync(wrappedMint, owner, true);
  console.log('wrapped mint:', wrappedMint.toBase58(), 'recipient ATA:', ata.toBase58());
  const ataIx = createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, owner, wrappedMint);
  const completeIx = await tokenBridge.createCompleteTransferWrappedInstruction(
    conn, TOKEN_BRIDGE, CORE, payer.publicKey, vaa);
  console.log('complete:', await sendTx([ataIx, completeIx], { computeBudget: true }));
  const bal = await conn.getTokenAccountBalance(ata);
  console.log('recipient ATA balance:', bal.value.uiAmountString);
}
console.log('DONE');
