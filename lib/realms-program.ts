// SPL Governance v3 ("Realms") program constants for the Cardo `/vote`
// integration.
//
// **Source of truth**: github.com/solana-labs/solana-program-library
// (`governance/program/src/instruction.rs`,
// `governance/program/src/state/{vote_record,token_owner_record,realm_config,enums}.rs`).
//
// SPL Governance is **not** Anchor — it's a native Solana program with
// a Borsh-serialized instruction enum. The on-the-wire instruction body
// is `borsh::to_vec(&GovernanceInstruction::CastVote { vote })`, which
// serializes to:
//   u8 tag (=11 for CastVote)        ← enum index, NOT sha256("global:")
//   borsh-encoded Vote enum body
//
// Devnet bootstrap state (verified live 2026-04-26):
//   - Program (GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw)
//     executable=true, owner=BPFLoaderUpgradeable.
//   - 1923 ProposalV2 accounts in state=Voting.
//   - 763 of those still inside (voting_at + voting_base_time
//     + voting_cool_off_time) > now.
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md

import type { Hex } from 'viem';
import { pubkeyBs58ToBytes32 } from './solana-pda';
import { solanaProgramId } from './solana-programs';

// ─────────────────────────────────────────────────────────────────────
// Program id (from @rome-protocol/registry).
//
// Same program id on devnet + mainnet (the SPL Governance team ships
// the program from a single canonical address).
// ─────────────────────────────────────────────────────────────────────

export const REALMS_PROGRAM_BS58 = solanaProgramId('splGovernance', 'devnet');

export const REALMS_PROGRAM: Hex = pubkeyBs58ToBytes32(REALMS_PROGRAM_BS58);

// ─────────────────────────────────────────────────────────────────────
// Borsh enum index for GovernanceInstruction::CastVote
//
// Walk through `pub enum GovernanceInstruction` in
// governance/program/src/instruction.rs counting variants from 0:
//   0  CreateRealm
//   1  DepositGoverningTokens
//   2  WithdrawGoverningTokens
//   3  SetGovernanceDelegate
//   4  CreateGovernance
//   5  CreateProposal
//   6  AddSignatory
//   7  InsertTransaction
//   8  RemoveTransaction
//   9  CancelProposal
//   10 SignOffProposal
//   11 CastVote          ← us
//   12 FinalizeVote
//   13 RelinquishVote
//   ...
// ─────────────────────────────────────────────────────────────────────

export const CAST_VOTE_TAG = 11;

// ─────────────────────────────────────────────────────────────────────
// Vote enum tags (Borsh enum index for `pub enum Vote` in
// `governance/program/src/state/vote_record.rs`):
//
//   0 Approve(Vec<VoteChoice>)
//   1 Deny
//   2 Abstain   (note: "Not supported in the current version", the
//                processor returns NotSupportedVoteType for it)
//   3 Veto      (only the council on multi-mint realms can cast Veto;
//                rejected here for Sprint 1 since we only support
//                Yes/No on single-choice proposals)
//
// VoteChoice = { rank: u8, weight_percentage: u8 } (2 bytes).
// ─────────────────────────────────────────────────────────────────────

export const VOTE_TAG_APPROVE = 0;
export const VOTE_TAG_DENY = 1;
export const VOTE_TAG_ABSTAIN = 2;
export const VOTE_TAG_VETO = 3;

// ─────────────────────────────────────────────────────────────────────
// PDA seed prefix used by all V1/V2/V3 governance PDAs (token_owner_record,
// vote_record, governance, proposal, etc.). Source: lib.rs:
//   pub const PROGRAM_AUTHORITY_SEED: &[u8] = b"governance";
// ─────────────────────────────────────────────────────────────────────

export const PROGRAM_AUTHORITY_SEED = Buffer.from('governance');

/// Seed for the `realm-config` PDA (introduced in V2):
///   PDA(["realm-config", realm], program_id)
export const REALM_CONFIG_SEED = Buffer.from('realm-config');

// ─────────────────────────────────────────────────────────────────────
// Account-type discriminator bytes (first byte of every governance
// account; this is `GovernanceAccountType` Borsh-serialized as a u8).
//
// Walk through `pub enum GovernanceAccountType` in enums.rs:
//   0  Uninitialized
//   1  RealmV1
//   2  TokenOwnerRecordV1
//   3  GovernanceV1
//   4  ProgramGovernanceV1
//   5  ProposalV1
//   6  SignatoryRecordV1
//   7  VoteRecordV1
//   8  ProposalInstructionV1
//   9  MintGovernanceV1
//   10 TokenGovernanceV1
//   11 RealmConfig
//   12 VoteRecordV2
//   13 ProposalTransactionV2
//   14 ProposalV2
//   15 ProgramMetadata
//   16 RealmV2
//   17 TokenOwnerRecordV2
//   18 GovernanceV2
//   ...
// ─────────────────────────────────────────────────────────────────────

export const ACCOUNT_TYPE_REALM_V2 = 16;
export const ACCOUNT_TYPE_TOKEN_OWNER_RECORD_V2 = 17;
export const ACCOUNT_TYPE_GOVERNANCE_V2 = 18;
export const ACCOUNT_TYPE_PROPOSAL_V2 = 14;

/// `pub enum ProposalState` — `Voting = 2`. Used as the bs58 memcmp
/// filter byte for `getProgramAccounts` to enumerate active proposals.
export const PROPOSAL_STATE_VOTING = 2;

// ─────────────────────────────────────────────────────────────────────
// CU budget (empirical estimate; cast_vote is ~10–11 accounts and
// allocates a fresh VoteRecordV2 PDA inside the program).
// ─────────────────────────────────────────────────────────────────────

export const CU_REALMS_CAST_VOTE = 100_000n;
