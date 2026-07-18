// Pre-simulate the JitoSOL deposit ix to find any error before bundling.
import fs from 'node:fs';
import path from 'node:path';
import { Connection, Keypair, PublicKey, Transaction, SystemProgram } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';

const RPC = 'https://api.mainnet-beta.solana.com';
const KEY_PATH = path.join(process.env.HOME, 'rome/.secrets/cardo-mainnet/orchestrator-v1.key');

const SPL_STAKE_POOL_PROGRAM = new PublicKey('SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy');
const JITOSOL_POOL = new PublicKey('Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb');
const JITOSOL_MINT = new PublicKey('J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn');
const JITOSOL_RESERVE = new PublicKey('BgKUXdS29YcHCFrPm5M8oLHiTzZaMDjsebggjoaQ6KFL');
const JITOSOL_MANAGER_FEE = new PublicKey('8yoigZfzZ1nNaadumY9uPVD118225UYHTDpmjpr2nrSa');

const [withdrawAuthority] = PublicKey.findProgramAddressSync(
  [JITOSOL_POOL.toBuffer(), Buffer.from('withdraw')],
  SPL_STAKE_POOL_PROGRAM,
);
console.log('withdrawAuthority:', withdrawAuthority.toBase58());

const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(KEY_PATH).toString())));
console.log('payer:', payer.publicKey.toBase58());

const conn = new Connection(RPC, 'confirmed');
const jitoSolAta = getAssociatedTokenAddressSync(JITOSOL_MINT, payer.publicKey);
console.log('JitoSOL ATA:', jitoSolAta.toBase58());

const { blockhash } = await conn.getLatestBlockhash('confirmed');

const tx = new Transaction({ recentBlockhash: blockhash, feePayer: payer.publicKey });
tx.add(
  createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, jitoSolAta, payer.publicKey, JITOSOL_MINT),
);

// build deposit ix manually
const data = Buffer.alloc(1 + 8);
data.writeUInt8(14, 0);
data.writeBigUInt64LE(5_000_000n, 1);
const depositIx = {
  programId: SPL_STAKE_POOL_PROGRAM,
  keys: [
    { pubkey: JITOSOL_POOL, isSigner: false, isWritable: true },
    { pubkey: withdrawAuthority, isSigner: false, isWritable: false },
    { pubkey: JITOSOL_RESERVE, isSigner: false, isWritable: true },
    { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    { pubkey: jitoSolAta, isSigner: false, isWritable: true },
    { pubkey: JITOSOL_MANAGER_FEE, isSigner: false, isWritable: true },
    { pubkey: JITOSOL_MANAGER_FEE, isSigner: false, isWritable: true },
    { pubkey: JITOSOL_MINT, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ],
  data,
};
tx.add(depositIx);
tx.sign(payer);

const sim = await conn.simulateTransaction(tx);
console.log('\n=== Simulation result ===');
console.log('  err:', JSON.stringify(sim.value.err));
console.log('  units:', sim.value.unitsConsumed);
console.log('  logs:');
for (const l of sim.value.logs ?? []) console.log('   ', l);
