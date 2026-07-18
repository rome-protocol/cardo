// SPL Governance v3 ("Realms") `cast_vote` invoke builder.
//
// Per `governance/program/src/instruction.rs::cast_vote`, the wire layout
// is 10 fixed accounts followed by an optional realm-config plug-in pair:
//
//   0.  realm                             (readonly)
//   1.  governance                        (writable)
//   2.  proposal                          (writable)
//   3.  proposal_owner_record             (writable)            ← TOR of proposer
//   4.  voter_token_owner_record          (writable)            ← caller's TOR
//   5.  governance_authority              (signer, readonly)    ← user's Rome PDA
//   6.  vote_record                       (writable)            ← PDA, will be created
//   7.  vote_governing_token_mint         (readonly)            ← realm.community or council
//   8.  payer                             (signer, writable)    ← user's Rome PDA
//   9.  system_program                    (readonly)
//   10. realm_config                      (readonly)            ← always passed
//   11. (optional) voter_weight_record    (readonly)            ← skipped Sprint 1
//   12. (optional) max_voter_weight_record(readonly)            ← skipped Sprint 1
//
// Args (Borsh):
//   u8 tag (=11, GovernanceInstruction::CastVote)
//   Vote enum body:
//     Vote::Approve(Vec<VoteChoice>) → tag 0 + u32 len + 2*N bytes
//        VoteChoice = { rank: u8, weight_percentage: u8 }
//     Vote::Deny                       → tag 1 (no body)
//     Vote::Abstain                    → tag 2 (REJECTED — processor returns NotSupportedVoteType)
//     Vote::Veto                       → tag 3 (REJECTED — Sprint 1, single-choice realms only)
//
// Source: github.com/solana-labs/solana-program-library
//   - governance/program/src/instruction.rs (lines 1009-1058)
//   - governance/program/src/processor/process_cast_vote.rs (account ordering)
//   - governance/program/src/state/vote_record.rs (Vote / VoteChoice enum)

import { concat, type Address, type Hex } from 'viem';
import { PublicKey } from '@solana/web3.js';
import type { AccountMeta } from './cpi-precompile';
import { deriveRomeUserPda, pubkeyToBytes32 } from './solana-pda';
import {
  CAST_VOTE_TAG,
  REALMS_PROGRAM,
  VOTE_TAG_APPROVE,
  VOTE_TAG_DENY,
} from './realms-program';
import { deriveRealmsCastVoteAddresses } from './realms-pdas';
import type { RealmsProposalEntry } from './realms-registry';

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

const SYSTEM_PROGRAM = pubkeyToBytes32(PublicKey.default);

// ─────────────────────────────────────────────────────────────────────
// Encoding helpers
// ─────────────────────────────────────────────────────────────────────

function toU8(v: number): Hex {
  if (!Number.isInteger(v) || v < 0 || v > 0xff) {
    throw new Error(`u8 out of range: ${v}`);
  }
  return ('0x' + v.toString(16).padStart(2, '0')) as Hex;
}

function toU32Le(v: number): Hex {
  if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) {
    throw new Error(`u32 out of range: ${v}`);
  }
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v, 0);
  return ('0x' + b.toString('hex')) as Hex;
}

// ─────────────────────────────────────────────────────────────────────
// Vote ADT (mirrors `pub enum Vote` in vote_record.rs)
//
// Sprint 1 surfaces only Approve + Deny. Abstain returns the program's
// `NotSupportedVoteType` error. Veto is council-only on multi-mint
// realms — out of scope for the v1 single-choice flow.
// ─────────────────────────────────────────────────────────────────────

export type RealmsVote =
  | { kind: 'yes'; choices: Array<{ rank: number; weightPercentage: number }> }
  | { kind: 'no' };

/// Encode a `Vote` enum body to Borsh bytes (without the surrounding
/// instruction tag — that's prefixed in `buildRealmsCastVoteInvoke`).
export function encodeVote(vote: RealmsVote): Hex {
  if (vote.kind === 'no') {
    return toU8(VOTE_TAG_DENY);
  }
  // Approve(Vec<VoteChoice>)
  const head = toU8(VOTE_TAG_APPROVE);
  const len = toU32Le(vote.choices.length);
  const body: Hex[] = [head, len];
  for (const c of vote.choices) {
    body.push(toU8(c.rank));
    body.push(toU8(c.weightPercentage));
  }
  return concat(body);
}

// ─────────────────────────────────────────────────────────────────────
// cast_vote invoke builder
// ─────────────────────────────────────────────────────────────────────

export type RealmsCastVoteAddresses = {
  user: Hex;
  realm: Hex;
  governance: Hex;
  proposal: Hex;
  proposalOwnerRecord: Hex;
  voterTokenOwnerRecord: Hex;
  voteRecord: Hex;
  governingTokenMint: Hex;
  realmConfig: Hex;
};

export type RealmsCastVoteInvoke = {
  program: Hex;
  accounts: AccountMeta[];
  data: Hex;
  addresses: RealmsCastVoteAddresses;
};

/// Build a `cast_vote` invoke against an existing Realms proposal.
///
/// **Caller pre-flight (NOT enforced inside the builder):**
///   1. The user's Rome PDA must already have a TokenOwnerRecord on the
///      target realm + governing-token mint, with non-zero deposited
///      governing tokens. Without it the program rejects with
///      `TokenOwnerRecordAccountAddressMismatch` (or similar) at runtime.
///   2. The proposal must still be inside its voting window
///      (voting_at + voting_base_time + voting_cool_off_time > now);
///      otherwise the program rejects with `ProposalVotingTimeExpired`.
///   3. The user must NOT have already voted on this proposal — the
///      VoteRecord PDA can only be created once. Re-voting yields
///      `VoteAlreadyExists`.
///
/// All three pre-flights are checked at UI-render time in
/// `useRealmsProposalState`.
export function buildRealmsCastVoteInvoke(args: {
  userEvmAddress: Address;
  proposal: RealmsProposalEntry;
  vote: RealmsVote;
}): RealmsCastVoteInvoke {
  const user = deriveRomeUserPda(args.userEvmAddress);

  const {
    voterTokenOwnerRecord,
    voteRecord,
    realmConfig,
  } = deriveRealmsCastVoteAddresses({
    userPdaHex: user,
    realmHex: args.proposal.realmHex,
    proposalHex: args.proposal.proposalHex,
    governingTokenMintHex: args.proposal.governingTokenMintHex,
  });

  const accounts: AccountMeta[] = [
    // 0. realm
    { pubkey: args.proposal.realmHex, is_signer: false, is_writable: false },
    // 1. governance
    { pubkey: args.proposal.governanceHex, is_signer: false, is_writable: true },
    // 2. proposal
    { pubkey: args.proposal.proposalHex, is_signer: false, is_writable: true },
    // 3. proposal_owner_record
    {
      pubkey: args.proposal.proposalOwnerRecordHex,
      is_signer: false,
      is_writable: true,
    },
    // 4. voter_token_owner_record
    { pubkey: voterTokenOwnerRecord, is_signer: false, is_writable: true },
    // 5. governance_authority — user's Rome PDA, signs as voter
    { pubkey: user, is_signer: true, is_writable: false },
    // 6. vote_record (PDA, created by the program)
    { pubkey: voteRecord, is_signer: false, is_writable: true },
    // 7. vote_governing_token_mint
    {
      pubkey: args.proposal.governingTokenMintHex,
      is_signer: false,
      is_writable: false,
    },
    // 8. payer — user's Rome PDA pays VoteRecord rent
    { pubkey: user, is_signer: true, is_writable: true },
    // 9. system_program
    { pubkey: SYSTEM_PROGRAM, is_signer: false, is_writable: false },
    // 10. realm_config
    { pubkey: realmConfig, is_signer: false, is_writable: false },
  ];

  const data = concat([toU8(CAST_VOTE_TAG), encodeVote(args.vote)]);

  return {
    program: REALMS_PROGRAM,
    accounts,
    data,
    addresses: {
      user,
      realm: args.proposal.realmHex,
      governance: args.proposal.governanceHex,
      proposal: args.proposal.proposalHex,
      proposalOwnerRecord: args.proposal.proposalOwnerRecordHex,
      voterTokenOwnerRecord,
      voteRecord,
      governingTokenMint: args.proposal.governingTokenMintHex,
      realmConfig,
    },
  };
}
