// Simulate the flagship bundle's tx4 (refresh + deposit) to find errors.
import fs from 'node:fs';
import path from 'node:path';
import { Connection, Keypair, PublicKey, Transaction, SystemProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, NATIVE_MINT } from '@solana/spl-token';

const RPC = 'https://api.mainnet-beta.solana.com';
const KEY_PATH = path.join(process.env.HOME, 'rome/.secrets/cardo-mainnet/orchestrator-v1.key');

const KLEND = new PublicKey('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');
const FARMS = new PublicKey('FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr');
const SYSVAR_INSTRUCTIONS = new PublicKey('Sysvar1nstructions1111111111111111111111111');
const KAMINO_MAIN_MARKET = new PublicKey('7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF');
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const KAMINO_USDC_RESERVE = new PublicKey('D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59');
const KAMINO_USDC_LIQUIDITY_SUPPLY = new PublicKey('Bgq7trRgVMeq33yt235zM2onQ4bRDBsY5EWiTetF4qw6');
const KAMINO_USDC_COLLATERAL_MINT = new PublicKey('B8V6WVjPxW1UGwVDfxH2d2r8SyT4cqn7dQRK6XneVa7D');
const KAMINO_USDC_DESTINATION_COLLATERAL = new PublicKey('3DzjXRfxRm6iejfyyMynR4tScddaanrePJ1NJU2XnPPL');
const RESERVE_FARM_STATE = new PublicKey('JAvnB9AKtgPsTEoKmn24Bq64UMoYcrtWtq42HHBdsPkh');

const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(KEY_PATH).toString())));
const usdcAta = getAssociatedTokenAddressSync(USDC_MINT, payer.publicKey);

// Derive PDAs
const [obligation] = PublicKey.findProgramAddressSync(
  [Buffer.from([0]), Buffer.from([0]), payer.publicKey.toBuffer(), KAMINO_MAIN_MARKET.toBuffer(), PublicKey.default.toBuffer(), PublicKey.default.toBuffer()],
  KLEND,
);
const [lendingMarketAuthority] = PublicKey.findProgramAddressSync(
  [Buffer.from('lma'), KAMINO_MAIN_MARKET.toBuffer()],
  KLEND,
);
const [obligationFarmUserState] = PublicKey.findProgramAddressSync(
  [Buffer.from('user'), RESERVE_FARM_STATE.toBuffer(), obligation.toBuffer()],
  FARMS,
);

const conn = new Connection(RPC, 'confirmed');
const { blockhash } = await conn.getLatestBlockhash('confirmed');

// Build tx4 only — assume USDC ATA + obligation already exist
const tx = new Transaction({ recentBlockhash: blockhash, feePayer: payer.publicKey });

// refresh_reserve — Scope-priced (USDC main reserve)
const SCOPE_PRICES = new PublicKey('3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH');
tx.add({
  programId: KLEND,
  keys: [
    { pubkey: KAMINO_USDC_RESERVE, isSigner: false, isWritable: true },
    { pubkey: KAMINO_MAIN_MARKET, isSigner: false, isWritable: false },
    { pubkey: KLEND, isSigner: false, isWritable: false },
    { pubkey: KLEND, isSigner: false, isWritable: false },
    { pubkey: KLEND, isSigner: false, isWritable: false },
    { pubkey: SCOPE_PRICES, isSigner: false, isWritable: false },
  ],
  data: Buffer.from('02da8aeb4fc91966', 'hex'),
});

// deposit_v2 — 17 accounts
const depositData = Buffer.alloc(16);
Buffer.from('d8e0bf1bcc9766af', 'hex').copy(depositData, 0);
depositData.writeBigUInt64LE(100_000n, 8); // 0.1 USDC

// refresh_obligation
tx.add({
  programId: KLEND,
  keys: [
    { pubkey: KAMINO_MAIN_MARKET, isSigner: false, isWritable: false },
    { pubkey: obligation,         isSigner: false, isWritable: true  },
  ],
  data: Buffer.from('218493e497c04859', 'hex'),
});

tx.add({
  programId: KLEND,
  keys: [
    { pubkey: payer.publicKey,                   isSigner: true,  isWritable: false },
    { pubkey: obligation,                        isSigner: false, isWritable: true  },
    { pubkey: KAMINO_MAIN_MARKET,                isSigner: false, isWritable: false },
    { pubkey: lendingMarketAuthority,            isSigner: false, isWritable: false },
    { pubkey: KAMINO_USDC_RESERVE,               isSigner: false, isWritable: true  },
    { pubkey: USDC_MINT,                         isSigner: false, isWritable: false },
    { pubkey: KAMINO_USDC_LIQUIDITY_SUPPLY,      isSigner: false, isWritable: true  },
    { pubkey: KAMINO_USDC_COLLATERAL_MINT,       isSigner: false, isWritable: true  },
    { pubkey: KAMINO_USDC_DESTINATION_COLLATERAL, isSigner: false, isWritable: true },
    { pubkey: usdcAta,                           isSigner: false, isWritable: true  },
    { pubkey: KLEND,                             isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID,                  isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID,                  isSigner: false, isWritable: false },
    { pubkey: SYSVAR_INSTRUCTIONS,               isSigner: false, isWritable: false },
    { pubkey: obligationFarmUserState,           isSigner: false, isWritable: true  },
    { pubkey: RESERVE_FARM_STATE,                isSigner: false, isWritable: true  },
    { pubkey: FARMS,                             isSigner: false, isWritable: false },
  ],
  data: depositData,
});

tx.sign(payer);

const sim = await conn.simulateTransaction(tx);
console.log('=== Simulation ===');
console.log('  err:', JSON.stringify(sim.value.err));
console.log('  units:', sim.value.unitsConsumed);
console.log('  logs (last 30):');
for (const l of (sim.value.logs ?? []).slice(-30)) console.log('   ', l);
