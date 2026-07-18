// deploy-fresh-token.mjs — bootstrap a brand-new SPL mint + ERC20-SPL
// wrapper on Rome, mint some to a target user, and print the entry
// to paste into ROME_STATIC_TOKENS.
//
// Why this exists: the missing-vault flow on /pool/new (and any new
// trading pair you'd want to bootstrap) needs a token whose Meteora
// vault doesn't exist yet. Existing wrappers (WUSDC, WWSOL, WETH) all
// have vaults already — testing the full create-vault → create-pool →
// swap chain requires fresh tokens. Run this whenever you need one.
//
// What the script does (idempotent at the contract level):
//   1. Generates a fresh SPL mint, payer is mint authority.
//   2. Creates the user's PDA-owned ATA (idempotent).
//   3. Mints `MINT_AMOUNT_HUMAN` of the new token to that ATA.
//   4. Calls ERC20SPLFactory.add_spl_token_no_metadata to deploy the
//      EVM wrapper. Reads the wrapper address from the factory's
//      `token_by_mint` mapping after the tx lands.
//
// Pre-conditions:
//   - Local payer keypair at ~/.rome-rome-solana-payer.json with
//     ≥ 0.005 SOL on devnet (rent for mint + ATA + a couple sigs).
//   - Local EVM deployer key at ~/.rome-rome-deployer.key with
//     ≥ 2 mETH on Rome (200M gas × 11 gwei ≈ 2.2 mETH for the
//     wrapper deploy). If short, refill via the rome-apps cli
//     `deposit` flow against the Solana payer's USDC ATA.
//
// Usage:
//   SYMBOL=FOO NAME='Foo Token' DECIMALS=6 USER=0xYourEvm... \
//     MINT_AMOUNT=1000 node scripts/deploy-fresh-token.mjs
//
// All env vars are optional except SYMBOL and USER:
//   SYMBOL        token symbol (required)
//   NAME          token name (default = `${SYMBOL} Token`)
//   DECIMALS      mint decimals (default 6)
//   USER          EVM address whose Rome PDA receives the mint
//                 (required — script doesn't assume a default)
//   MINT_AMOUNT   human-readable amount (default 1000)
//   GAS_LIMIT     EVM gas limit for the wrapper deploy (default
//                 200_000_000 — leaves room over the ~134M observed
//                 actual gas use)
//   GAS_PRICE     wei/gas (default 11_000_000_000 = 11 gwei to match
//                 Rome's min)

import fs from 'node:fs';
import os from 'node:os';
import { ethers } from 'ethers';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  createMint,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToCheckedInstruction,
} from '@solana/spl-token';

const SOL_RPC = 'https://api.devnet.solana.com';
const ROME_RPC = 'https://rome.devnet.romeprotocol.xyz/';
const ROME_EVM_PROGRAM_ID = new PublicKey('DP1dshBzmXXVsRxH5kCKMemrDuptg1JvJ1j5AsFV4Hm3');
const FACTORY_ADDR = '0x266c57c28fd55ad6b7e3a503ba29eb1510c1574d';

const SYMBOL = process.env.SYMBOL;
const NAME = process.env.NAME ?? (SYMBOL ? `${SYMBOL} Token` : null);
const DECIMALS = parseInt(process.env.DECIMALS ?? '6', 10);
const USER_EVM = process.env.USER;
const MINT_AMOUNT_HUMAN = BigInt(process.env.MINT_AMOUNT ?? '1000');
const GAS_LIMIT = BigInt(process.env.GAS_LIMIT ?? '200000000');
const GAS_PRICE = BigInt(process.env.GAS_PRICE ?? '11000000000');

if (!SYMBOL || !USER_EVM) {
  console.error('Usage: SYMBOL=<sym> USER=0x... [NAME=...] [DECIMALS=6] [MINT_AMOUNT=1000] node scripts/deploy-fresh-token.mjs');
  process.exit(1);
}
if (!/^0x[0-9a-fA-F]{40}$/.test(USER_EVM)) {
  console.error(`USER must be a 0x EVM address, got: ${USER_EVM}`);
  process.exit(1);
}

function deriveRomeUserPda(evmAddr) {
  const userBytes = Buffer.from(evmAddr.slice(2), 'hex');
  return PublicKey.findProgramAddressSync(
    [Buffer.from('EXTERNAL_AUTHORITY'), userBytes],
    ROME_EVM_PROGRAM_ID,
  )[0];
}

async function main() {
  console.log(`━━━ Bootstrapping fresh token ${SYMBOL} ━━━`);
  console.log(`  name: ${NAME}`);
  console.log(`  decimals: ${DECIMALS}`);
  console.log(`  mint amount: ${MINT_AMOUNT_HUMAN} ${SYMBOL}`);
  console.log(`  recipient EVM: ${USER_EVM}`);

  const conn = new Connection(SOL_RPC, 'confirmed');
  const payerSecret = JSON.parse(
    fs.readFileSync(os.homedir() + '/.rome-rome-solana-payer.json', 'utf8'),
  );
  const payer = Keypair.fromSecretKey(Uint8Array.from(payerSecret));
  console.log(`  Solana payer: ${payer.publicKey.toBase58()}`);

  const userPda = deriveRomeUserPda(USER_EVM);
  console.log(`  user Rome PDA: ${userPda.toBase58()}`);

  // Step 1: create the SPL mint
  console.log('\n[1/3] Creating SPL mint…');
  const mint = await createMint(conn, payer, payer.publicKey, null, DECIMALS);
  console.log(`  mint: ${mint.toBase58()}`);
  console.log(`  mint hex: 0x${mint.toBuffer().toString('hex')}`);

  // Step 2: create user's ATA + mint
  console.log(`\n[2/3] Minting ${MINT_AMOUNT_HUMAN} ${SYMBOL} to user PDA's ATA…`);
  const ata = getAssociatedTokenAddressSync(mint, userPda, true);
  const rawAmount = MINT_AMOUNT_HUMAN * 10n ** BigInt(DECIMALS);
  const tx = new Transaction()
    .add(createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey, ata, userPda, mint,
      TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    ))
    .add(createMintToCheckedInstruction(
      mint, ata, payer.publicKey, rawAmount, DECIMALS, [],
      TOKEN_PROGRAM_ID,
    ));
  const sig = await sendAndConfirmTransaction(conn, tx, [payer]);
  console.log(`  ATA: ${ata.toBase58()}`);
  console.log(`  tx: ${sig}`);

  // Step 3: deploy EVM wrapper
  console.log('\n[3/3] Deploying ERC20-SPL wrapper…');
  const evmKey = '0x' + fs
    .readFileSync(os.homedir() + '/.rome-rome-deployer.key', 'utf8')
    .trim()
    .replace(/^0x/, '');
  const provider = new ethers.JsonRpcProvider(ROME_RPC);
  const wallet = new ethers.Wallet(evmKey, provider);
  const balance = await provider.getBalance(wallet.address);
  const weiNeeded = GAS_LIMIT * GAS_PRICE;
  console.log(`  deployer: ${wallet.address}`);
  console.log(`  deployer balance: ${ethers.formatEther(balance)} mETH`);
  console.log(`  needed: ${ethers.formatEther(weiNeeded)} mETH (gas_limit × gas_price)`);
  if (balance < weiNeeded) {
    console.error('  deployer balance too low — refill via the rome-apps cli `deposit` flow before retrying');
    process.exit(1);
  }

  const factory = new ethers.Contract(
    FACTORY_ADDR,
    [
      'function add_spl_token_no_metadata(bytes32 mint, string name, string symbol) returns (address)',
      'function token_by_mint(bytes32) view returns (address)',
    ],
    wallet,
  );
  const mintBytes32 = '0x' + mint.toBuffer().toString('hex');
  const txEvm = await factory.add_spl_token_no_metadata(mintBytes32, NAME, SYMBOL, {
    type: 0,
    gasPrice: GAS_PRICE,
    gasLimit: GAS_LIMIT,
  });
  console.log(`  evm tx: ${txEvm.hash}`);
  const receipt = await txEvm.wait();
  console.log(`  block: ${receipt.blockNumber}  status: ${receipt.status}  gasUsed: ${receipt.gasUsed.toString()}`);

  // Read wrapper address from the factory's mapping (TokenCreated event
  // is emitted but we don't depend on log parsing).
  const wrapper = await factory.token_by_mint(mintBytes32);
  console.log(`\n━━━ Done ━━━`);
  console.log(`  wrapper: ${wrapper}`);
  console.log('');
  console.log('Add to lib/addresses.ts ROME_STATIC_TOKENS:');
  console.log(`  {
    address: '${wrapper.toLowerCase()}',
    symbol: '${SYMBOL}',
    name: '${NAME}',
    decimals: ${DECIMALS},
    mintAddress: '${mint.toBase58()}',
    swappable: false,
  },`);
  console.log('\nThen rebuild Cardo and visit /pool/new — the token will appear in the picker with vault missing, ready to test the Create vault flow.');
}

main().catch((e) => { console.error('ERROR', e); process.exit(1); });
