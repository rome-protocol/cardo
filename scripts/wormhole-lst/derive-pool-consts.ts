// Print the ROME_METEORA_POOL-shaped constant blocks for the USDC↔LST
// DAMM v1 pools, derived with the exact same code path create-pool uses
// (lib/meteora-pool-create.ts). Paste output into lib/meteora-pool.ts.
//
//   node --import tsx scripts/wormhole-lst/derive-pool-consts.ts

import { privateKeyToAccount } from 'viem/accounts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PublicKey } from '@solana/web3.js';
import {
  derivePoolCreateAddresses,
  deriveMeteoraVault,
  pubkeyBs58ToBytes32,
  METEORA_VAULT_PROGRAM_ID,
  type VaultStateOverrides,
} from '../../lib/meteora-pool-create.ts';
import { pubkeyToBytes32, SPL_TOKEN_PROGRAM_ID } from '../../lib/solana-pda.ts';

const SOL_RPC = process.env.SOLANA_RPC ?? 'https://api.devnet.solana.com';

async function rpcGetAccount(pk: string): Promise<Buffer | null> {
  const res = await fetch(SOL_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [pk, { encoding: 'base64' }],
    }),
  });
  const j = await res.json();
  return j?.result?.value ? Buffer.from(j.result.value.data[0], 'base64') : null;
}

/// On-chain (token_vault, lp_mint) for a mint's vault — legacy vaults
/// store non-PDA lp_mints (offsets per use-meteora-vault-states.ts).
async function vaultOverrideFor(mintB58: string): Promise<VaultStateOverrides[string] | null> {
  const data = await rpcGetAccount(deriveMeteoraVault(new PublicKey(mintB58)).toBase58());
  if (!data) return null;
  return {
    tokenVault: `0x${data.subarray(19, 51).toString('hex')}` as `0x${string}`,
    lpMint: `0x${data.subarray(115, 147).toString('hex')}` as `0x${string}`,
  };
}

const USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const LSTS = [
  // Real devnet Marinade mSOL — mintable in-product via /stake-marinade.
  { constName: 'ROME_METEORA_POOL_USDC_MSOL', symbol: 'mSOL', mint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So' },
  // Wormhole-wrapped JitoSOL (Sepolia origin 0x46FF8Fc9…) — no mintable
  // devnet Jito exists, so the Wormhole lane is the canonical source.
  { constName: 'ROME_METEORA_POOL_USDC_WJITOSOL', symbol: 'wJitoSOL', mint: '8uz9RSxeKQxS1q3Cvs8xzNDTapUdJWRZhcHG2GegEtMS' },
];

function keyFile(): string {
  return process.env.E2E_TREASURY_PRIVATE_KEY_FILE
    ?? path.join(os.homedir(), 'rome/.secrets/e2e/treasury-evm.key');
}
const raw = fs.readFileSync(keyFile(), 'utf8').trim();
const evm = privateKeyToAccount((raw.startsWith('0x') ? raw : `0x${raw}`) as `0x${string}`).address;

async function main() {
for (const lst of LSTS) {
  const vaultOverrides: VaultStateOverrides = {};
  for (const m of [USDC, lst.mint]) {
    const over = await vaultOverrideFor(m);
    if (over) vaultOverrides[pubkeyBs58ToBytes32(m).toLowerCase()] = over;
  }
  const a = derivePoolCreateAddresses({
    userEvmAddress: evm,
    mintAHex: pubkeyBs58ToBytes32(USDC),
    mintBHex: pubkeyBs58ToBytes32(lst.mint),
    tradeFeeBps: 25n,
    vaultOverrides,
  });
  // Every account must exist on-chain once the pool is created — flag
  // any that don't so stale constants can't land in the registry.
  for (const [k, v] of Object.entries({
    pool: a.pool, aVault: a.aVault, bVault: a.bVault, aVaultLp: a.aVaultLp, bVaultLp: a.bVaultLp,
    aTokenVault: a.aTokenVault, bTokenVault: a.bTokenVault, aVaultLpMint: a.aVaultLpMint,
    bVaultLpMint: a.bVaultLpMint, protocolTokenAFee: a.protocolTokenAFee, protocolTokenBFee: a.protocolTokenBFee,
  })) {
    const ok = !!(await rpcGetAccount((v as PublicKey).toBase58()));
    if (!ok) console.log(`// WARNING ${lst.constName}.${k} = ${(v as PublicKey).toBase58()} NOT on chain yet`);
  }
  const h = (pk: PublicKey) => `'${pubkeyToBytes32(pk)}' as Hex`;
  console.log(`
/// USDC ↔ ${lst.symbol} pool (Wormhole-wrapped LST, 0.25% tier).
///   bs58 pool: ${a.pool.toBase58()}
///   tokenAMint = USDC (4zMM…ncDU) — A side
///   tokenBMint = ${lst.symbol} (${lst.mint})
export const ${lst.constName} = {
  pool: ${h(a.pool)},
  aVault: ${h(a.aVault)},
  bVault: ${h(a.bVault)},
  aVaultLp: ${h(a.aVaultLp)},
  bVaultLp: ${h(a.bVaultLp)},
  aTokenVault: ${h(a.aTokenVault)},
  bTokenVault: ${h(a.bTokenVault)},
  aVaultLpMint: ${h(a.aVaultLpMint)},
  bVaultLpMint: ${h(a.bVaultLpMint)},
  vaultProgram: ${h(METEORA_VAULT_PROGRAM_ID)},
  tokenProgram: ${h(SPL_TOKEN_PROGRAM_ID)},
  protocolTokenAFee: ${h(a.protocolTokenAFee)},
  protocolTokenBFee: ${h(a.protocolTokenBFee)},
  splMintA: '${pubkeyBs58ToBytes32(USDC)}' as Hex, // USDC
  splMintB: '${pubkeyBs58ToBytes32(lst.mint)}' as Hex, // ${lst.symbol}
} as const;`);
}
}

main().catch((e) => { console.error(e); process.exit(1); });
