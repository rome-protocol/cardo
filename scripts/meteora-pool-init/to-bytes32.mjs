// Convert all bs58 pubkeys in output.json to 0x-prefixed bytes32 hex
import { PublicKey } from '@solana/web3.js';
import fs from 'node:fs';

const out = JSON.parse(fs.readFileSync('/tmp/meteora-pool-init/output.json'));
const toHex = (s) => '0x' + new PublicKey(s).toBuffer().toString('hex');

const hex = {
  pool: toHex(out.pool),
  tokenAMint: toHex(out.tokenAMint),
  tokenBMint: toHex(out.tokenBMint),
  aVault: toHex(out.aVault),
  bVault: toHex(out.bVault),
  aVaultLp: toHex(out.aVaultLp),
  bVaultLp: toHex(out.bVaultLp),
  aVaultLpMint: toHex(out.aVaultLpMint),
  bVaultLpMint: toHex(out.bVaultLpMint),
  protocolTokenAFee: toHex(out.protocolTokenAFee),
  protocolTokenBFee: toHex(out.protocolTokenBFee),
  aTokenVault: toHex(out.aTokenVault),
  bTokenVault: toHex(out.bTokenVault),
  vaultProgram: toHex(out.vaultProgram),
  tokenProgram: toHex(out.tokenProgram),
  meteoraDammV1Program: toHex(out.meteoraDammV1Program),
};
console.log(JSON.stringify(hex, null, 2));
fs.writeFileSync('/tmp/meteora-pool-init/output.bytes32.json', JSON.stringify(hex, null, 2));
