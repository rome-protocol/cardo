// Realms bootstrap: create a test DAO (Realms governance instance) on
// devnet so Cardo's Realms vote-cast adapter has somewhere to vote.
//
// Flow (per @solana/spl-governance):
//   1. createRealm — creates the Realms instance
//   2. createGovernance — registers a governance config
//   3. depositGoverningTokens — bootstrap voting power for the user
//
// Once this runs, pin the produced realm + governance + token-owner-record
// pubkeys in `lib/realms-registry.ts`.
//
// Usage:
//   ANCHOR_WALLET=scripts/keys/cardo-bootstrap.devnet.priv.json \
//     npx ts-node scripts/bootstrap/02-realms-create-test-dao.ts
//
// PARTIAL: this script writes the bootstrap-script scaffolding. The
// actual @solana/spl-governance ix builders take many parameters
// (community/council mint config, vote thresholds, etc.) — full
// implementation lands in a follow-up commit once the keypair is
// funded and we can iterate against live RPC errors.

import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import * as fs from 'fs';

const GOVERNANCE_PROGRAM = new PublicKey(
  'GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw',
);
const RPC_URL = 'https://api.devnet.solana.com';

async function main() {
  const walletPath = process.env.ANCHOR_WALLET;
  if (!walletPath) {
    throw new Error('set ANCHOR_WALLET to bootstrap keypair path');
  }
  const secretKey = JSON.parse(fs.readFileSync(walletPath, 'utf8'));
  const payer = Keypair.fromSecretKey(Uint8Array.from(secretKey));
  const connection = new Connection(RPC_URL, 'confirmed');

  console.log('payer:', payer.publicKey.toBase58());
  const balance = await connection.getBalance(payer.publicKey);
  console.log('payer balance:', balance / LAMPORTS_PER_SOL, 'SOL');

  if (balance < 0.5 * LAMPORTS_PER_SOL) {
    throw new Error(
      `payer needs at least 0.5 SOL for DAO creation rents; current ${balance / LAMPORTS_PER_SOL}`,
    );
  }

  console.log('\nNOTE: full Realms DAO creation requires @solana/spl-governance');
  console.log('SDK calls (createRealm + createGovernance + depositGoverningTokens).');
  console.log('Install via: npm i @solana/spl-governance');
  console.log('Then implement using GovernanceProgram client per:');
  console.log('  https://github.com/solana-labs/governance-program-library');
  console.log('');
  console.log('Stub for now — re-run after install + implementation.');
}

main().catch((e) => {
  console.error('bootstrap failed:', e);
  process.exit(1);
});

// TODO: full implementation
//
// Pseudo-code:
//   const communityMint = await createMint(connection, payer, payer.publicKey, null, 6);
//   const realm = await createRealm(connection, payer, "Cardo Test DAO", communityMint, ...);
//   const governance = await createGovernance(connection, payer, realm, ...);
//   const tokenOwnerRecord = await depositGoverningTokens(connection, payer, realm, ...);
//
//   console.log('Realm pubkey:', realm.toBase58());
//   console.log('Governance pubkey:', governance.toBase58());
//   console.log('Token-owner-record:', tokenOwnerRecord.toBase58());
//   console.log('Community mint:', communityMint.toBase58());
//   console.log('\nPin these in lib/realms-registry.ts.');

void GOVERNANCE_PROGRAM;
