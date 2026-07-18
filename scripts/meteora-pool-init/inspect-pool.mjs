// inspect-pool.mjs — load the existing USDC/WSOL Meteora pool and emit
// the full account list Cardo's swap encoder needs.

import { AmmImpl } from '@meteora-ag/dynamic-amm-sdk';
import { Connection, PublicKey } from '@solana/web3.js';
import fs from 'node:fs';

const RPC = 'https://api.devnet.solana.com';
const POOL = new PublicKey('YxX5pw3A5orw68fqJE7ZzqbKfdbm6WWcL5E57A4EEV2');

const conn = new Connection(RPC, 'confirmed');
const poolImpl = await AmmImpl.create(conn, POOL);

console.log('pool:                ', POOL.toBase58());
console.log('tokenAMint:          ', poolImpl.tokenAMint.address.toString());
console.log('tokenBMint:          ', poolImpl.tokenBMint.address.toString());
console.log('isStable:            ', poolImpl.isStablePool);
console.log('tradeFeeBps:         ', poolImpl.feeBps?.toString?.() ?? 'n/a');

const ps = poolImpl.poolState;
const aVaultLpMint = poolImpl.vaultA.vaultState.lpMint;
const bVaultLpMint = poolImpl.vaultB.vaultState.lpMint;
console.log('\nPool state accounts:');
for (const k of [
  'tokenAMint', 'tokenBMint',
  'aVault', 'bVault',
  'aVaultLp', 'bVaultLp',
  'protocolTokenAFee', 'protocolTokenBFee',
  'lpMint',
]) {
  const v = ps[k];
  if (v && typeof v.toBase58 === 'function') console.log(`  ${k.padEnd(20)} ${v.toBase58()}`);
}
console.log(`  aVaultLpMint         ${aVaultLpMint.toBase58()}`);
console.log(`  bVaultLpMint         ${bVaultLpMint.toBase58()}`);

const aTokenVault = poolImpl.vaultA.vaultState.tokenVault.toBase58();
const bTokenVault = poolImpl.vaultB.vaultState.tokenVault.toBase58();
console.log('  aTokenVault          ', aTokenVault);
console.log('  bTokenVault          ', bTokenVault);

// Vault program id — Mercurial's program; pull from the SDK's vault impl
const vaultProgram = poolImpl.vaultA.program.programId.toBase58();
console.log('  vaultProgram         ', vaultProgram);

// Reserves (already deposited liquidity)
const aReserveAcc = await conn.getTokenAccountBalance(poolImpl.vaultA.vaultState.tokenVault);
const bReserveAcc = await conn.getTokenAccountBalance(poolImpl.vaultB.vaultState.tokenVault);
console.log('\nReserves:');
console.log('  vaultA token reserve:', aReserveAcc.value.uiAmountString, '(',aReserveAcc.value.amount, 'raw)');
console.log('  vaultB token reserve:', bReserveAcc.value.uiAmountString, '(',bReserveAcc.value.amount, 'raw)');

const out = {
  rpc: RPC,
  pool: POOL.toBase58(),
  tokenAMint: ps.tokenAMint.toBase58(),
  tokenBMint: ps.tokenBMint.toBase58(),
  aVault: ps.aVault.toBase58(),
  bVault: ps.bVault.toBase58(),
  aVaultLp: ps.aVaultLp.toBase58(),
  bVaultLp: ps.bVaultLp.toBase58(),
  aVaultLpMint: aVaultLpMint.toBase58(),
  bVaultLpMint: bVaultLpMint.toBase58(),
  protocolTokenAFee: ps.protocolTokenAFee.toBase58(),
  protocolTokenBFee: ps.protocolTokenBFee.toBase58(),
  lpMint: ps.lpMint.toBase58(),
  aTokenVault,
  bTokenVault,
  vaultProgram,
  tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  meteoraDammV1Program: 'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB',
  reserves: {
    aReserve: aReserveAcc.value.amount,
    bReserve: bReserveAcc.value.amount,
  },
  tradeFeeBps: 25,
  isStable: false,
};
fs.writeFileSync('/tmp/meteora-pool-init/output.json', JSON.stringify(out, null, 2));
console.log('\nwrote /tmp/meteora-pool-init/output.json');
