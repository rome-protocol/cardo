// create-vault.mjs — initialize a Meteora dynamic-vault for an SPL mint
// on Solana devnet. Necessary preamble before Meteora pool init can
// run for that mint (Cardo's /pool/new pre-flight gates on this).
//
// Why the user might need this: only USDC and WSOL have devnet vaults
// shipped today. To create a pool for any other mint (e.g. WETH), the
// vault for that mint must be initialized first.
//
// Submission path: direct Solana tx using the local payer keypair —
// `~/.rome-rome-solana-payer.json`. NOT via Rome's CPI precompile,
// because the local payer holds an actual Solana keypair (so signing
// is straightforward) and we don't need EVM gas for it. Vault init is
// independent of any chain — once it's on devnet, *every* Rome network
// can use it.
//
// Usage:
//   MINT=<base58 mint pubkey> node scripts/create-vault.mjs
//
//   # WETH on Rome: 6F5YWWrUMNpee8C6BDUc6DmRvYRMDDTgJHwKhbXuifWs
//   MINT=6F5YWWrUMNpee8C6BDUc6DmRvYRMDDTgJHwKhbXuifWs node scripts/create-vault.mjs

import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import solw3 from '@solana/web3.js';

const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} = solw3;
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

const RPC = 'https://api.devnet.solana.com';
const VAULT_PROGRAM = new PublicKey('24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi');
const BASE = new PublicKey('HWzXGcGHy4tcpYfaRDCyLNzXqBTv3E6BttpCH2vJxArv');

// Anchor instruction discriminator: sha256("global:initialize")[0..8]
const INIT_DISC = crypto
  .createHash('sha256')
  .update('global:initialize')
  .digest()
  .subarray(0, 8);

function deriveVault(mint) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), mint.toBuffer(), BASE.toBuffer()],
    VAULT_PROGRAM,
  )[0];
}
function deriveTokenVault(vault) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('token_vault'), vault.toBuffer()],
    VAULT_PROGRAM,
  )[0];
}
function deriveLpMint(vault) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('lp_mint'), vault.toBuffer()],
    VAULT_PROGRAM,
  )[0];
}

async function main() {
  const mintBs58 = process.env.MINT;
  if (!mintBs58) {
    console.error('Usage: MINT=<base58 mint pubkey> node scripts/create-vault.mjs');
    process.exit(1);
  }
  const mint = new PublicKey(mintBs58);
  const vault = deriveVault(mint);
  const tokenVault = deriveTokenVault(vault);
  const lpMint = deriveLpMint(vault);

  console.log('━━━ Meteora vault init ━━━');
  console.log('  mint:        ', mint.toBase58());
  console.log('  vault:       ', vault.toBase58());
  console.log('  token_vault: ', tokenVault.toBase58());
  console.log('  lp_mint:     ', lpMint.toBase58());

  const conn = new Connection(RPC, 'confirmed');

  // Pre-flight: does the vault already exist?
  const existing = await conn.getAccountInfo(vault);
  if (existing) {
    if (existing.owner.equals(VAULT_PROGRAM)) {
      console.log('  ✓ vault already exists (owner=Meteora vault program). Nothing to do.');
      return;
    }
    console.log('  ⚠ account at vault PDA is owned by', existing.owner.toBase58(), '— not the vault program');
    process.exit(1);
  }

  const secret = JSON.parse(
    fs.readFileSync(os.homedir() + '/.rome-rome-solana-payer.json', 'utf8'),
  );
  const payer = Keypair.fromSecretKey(Uint8Array.from(secret));
  console.log('  payer:       ', payer.publicKey.toBase58());

  const payerBal = await conn.getBalance(payer.publicKey);
  console.log('  payer SOL:   ', payerBal / 1e9);
  if (payerBal < 50_000_000) {
    console.error('payer needs ~0.05 SOL for vault rent — fund it and retry');
    process.exit(1);
  }

  // Order from rome-sdk dynamic-vault Initialize struct:
  //   0 vault         (init, w)
  //   1 payer         (signer, w)
  //   2 token_vault   (init, w)
  //   3 token_mint    (r)
  //   4 lp_mint       (init, w)
  //   5 rent          (sysvar)
  //   6 token_program (r)
  //   7 system_program(r)
  const keys = [
    { pubkey: vault, isSigner: false, isWritable: true },
    { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    { pubkey: tokenVault, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: lpMint, isSigner: false, isWritable: true },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  const ix = new TransactionInstruction({
    programId: VAULT_PROGRAM,
    keys,
    data: Buffer.from(INIT_DISC), // initialize takes no args
  });

  const tx = new Transaction().add(ix);
  console.log('  submitting…');
  const sig = await sendAndConfirmTransaction(conn, tx, [payer]);
  console.log('  ✓ tx:', sig);

  // Re-read to confirm
  const after = await conn.getAccountInfo(vault);
  if (after && after.owner.equals(VAULT_PROGRAM)) {
    console.log('  ✓ vault now exists, size:', after.data.length, 'bytes');
  } else {
    console.error('  vault did NOT land — investigate');
    process.exit(1);
  }
}

main().catch((e) => { console.error('ERROR', e); process.exit(1); });
