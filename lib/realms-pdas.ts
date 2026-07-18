// SPL Governance ("Realms") PDA derivations.
//
// Source: github.com/solana-labs/solana-program-library
//   - governance/program/src/state/token_owner_record.rs
//     `get_token_owner_record_address_seeds`
//   - governance/program/src/state/vote_record.rs
//     `get_vote_record_address_seeds`
//   - governance/program/src/state/realm_config.rs
//     `get_realm_config_address_seeds`
//
// Verified live 2026-04-26: realm-config PDA derivation against
// realm `779Wgyb…` produced `G4RHJqD6v2NnYSAciN9R1isHJzqudfHZ2Dra2xbbrS7o`.

import { PublicKey } from '@solana/web3.js';
import type { Hex } from 'viem';
import {
  bytes32ToPublicKey,
  pubkeyBs58ToBytes32,
  pubkeyToBytes32,
} from './solana-pda';
import {
  PROGRAM_AUTHORITY_SEED,
  REALM_CONFIG_SEED,
  REALMS_PROGRAM_BS58,
} from './realms-program';

const REALMS_PROGRAM_PK = new PublicKey(REALMS_PROGRAM_BS58);

/// `realm-config` PDA: PDA(["realm-config", realm], program).
/// Always passed (writable=false) at index 10 of the cast_vote ix.
/// If the realm pre-dates V2 the account may not exist on-chain — the
/// program's `get_realm_config_data_for_realm` accepts that path and
/// substitutes default `RealmConfigAccount` values, so liquid-governance
/// realms vote correctly even without an explicit realm-config account.
export function deriveRealmConfig(realmHex: Hex): Hex {
  const realm = bytes32ToPublicKey(realmHex);
  const [pda] = PublicKey.findProgramAddressSync(
    [REALM_CONFIG_SEED, realm.toBuffer()],
    REALMS_PROGRAM_PK,
  );
  return pubkeyToBytes32(pda);
}

/// TokenOwnerRecord PDA:
///   PDA(["governance", realm, governing_token_mint, owner], program).
/// `owner` here is the user's Rome PDA — Rome's CPI precompile signs as
/// that PDA when `msg.sender == userEoa`, so the TOR's
/// `governing_token_owner` field must match it for `cast_vote` to pass
/// `assert_token_owner_or_delegate_is_signer`.
export function deriveTokenOwnerRecord(
  realmHex: Hex,
  governingTokenMintHex: Hex,
  ownerHex: Hex,
): Hex {
  const realm = bytes32ToPublicKey(realmHex);
  const mint = bytes32ToPublicKey(governingTokenMintHex);
  const owner = bytes32ToPublicKey(ownerHex);
  const [pda] = PublicKey.findProgramAddressSync(
    [
      PROGRAM_AUTHORITY_SEED,
      realm.toBuffer(),
      mint.toBuffer(),
      owner.toBuffer(),
    ],
    REALMS_PROGRAM_PK,
  );
  return pubkeyToBytes32(pda);
}

/// VoteRecord PDA:
///   PDA(["governance", proposal, voter_token_owner_record], program).
/// Created by `cast_vote` itself, so the account address is what matters
/// here, not its existence — the program rejects the call with
/// `VoteAlreadyExists` if the account is already initialized.
export function deriveVoteRecord(
  proposalHex: Hex,
  voterTokenOwnerRecordHex: Hex,
): Hex {
  const proposal = bytes32ToPublicKey(proposalHex);
  const tor = bytes32ToPublicKey(voterTokenOwnerRecordHex);
  const [pda] = PublicKey.findProgramAddressSync(
    [PROGRAM_AUTHORITY_SEED, proposal.toBuffer(), tor.toBuffer()],
    REALMS_PROGRAM_PK,
  );
  return pubkeyToBytes32(pda);
}

/// Convenience: compute every PDA the cast_vote ix needs given a user's
/// Rome PDA + a curated registry entry.
export function deriveRealmsCastVoteAddresses(args: {
  userPdaHex: Hex;
  realmHex: Hex;
  proposalHex: Hex;
  governingTokenMintHex: Hex;
}): {
  voterTokenOwnerRecord: Hex;
  voteRecord: Hex;
  realmConfig: Hex;
} {
  const voterTokenOwnerRecord = deriveTokenOwnerRecord(
    args.realmHex,
    args.governingTokenMintHex,
    args.userPdaHex,
  );
  const voteRecord = deriveVoteRecord(args.proposalHex, voterTokenOwnerRecord);
  const realmConfig = deriveRealmConfig(args.realmHex);
  return { voterTokenOwnerRecord, voteRecord, realmConfig };
}

/// Pubkey-conversion helpers exported for test cases that already work in
/// bs58 strings.
export { pubkeyBs58ToBytes32 };
