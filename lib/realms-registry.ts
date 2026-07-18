// Curated registry of (realm, proposal) pairs Cardo's `/vote` UI ships
// with. Pinning at most one Sprint 1 entry — the page is intentionally
// stripped down: pick a realm + a single in-flight proposal, render
// Yes / No, submit one cast_vote.
//
// **Caveat (devnet only)**: SPL Governance proposals have a fixed
// voting window. The pinned proposal below was scoped on 2026-04-26
// using a sweep of all 1923 ProposalV2 accounts in `state=Voting`
// (filter: `getProgramAccounts` memcmp at offsets 0 + 65 of the data
// buffer). The chosen proposal is on a long-lived test realm whose
// `voting_base_time` is ~55 years — so the page should keep working
// for the foreseeable future, but the exact pubkeys could go stale
// if the realm or its DAO is reset on devnet. If that happens, swap
// in a new entry (search criteria + verified-live timestamps below).

import type { Hex } from 'viem';
import { pubkeyBs58ToBytes32 } from './solana-pda';

export type RealmsProposalEntry = {
  /// Display label.
  label: string;
  /// Realm bs58 + hex.
  realmBs58: string;
  realmHex: Hex;
  realmName: string;
  /// Governance account (the Proposal's parent).
  governanceBs58: string;
  governanceHex: Hex;
  /// Proposal bs58 + hex.
  proposalBs58: string;
  proposalHex: Hex;
  /// Proposal display name + optional description excerpt (for the UI).
  proposalName: string;
  proposalDescription: string;
  /// Governing-token mint the proposal accepts votes against. The user
  /// must hold a TokenOwnerRecord keyed on this exact mint to vote.
  governingTokenMintBs58: string;
  governingTokenMintHex: Hex;
  governingTokenLabel: 'community' | 'council';
  /// `proposal_owner_record` — the TOR of whoever created the proposal.
  /// Always passed at index 3 of cast_vote (writable). Pinned here
  /// because the program needs the exact account; we don't try to
  /// re-derive it (would require the proposer's pubkey + governing-mint).
  proposalOwnerRecordBs58: string;
  proposalOwnerRecordHex: Hex;
  /// Whether this proposal accepts a `Vote::Deny` (i.e. has the deny
  /// option). Yes/No proposals must have it; pure survey proposals do
  /// not. Sprint 1 only pins Yes/No-shaped proposals.
  hasDenyOption: boolean;
  /// VoteType of the proposal (Sprint 1 only ships `'single_choice'`).
  voteType: 'single_choice';
  /// Single-choice proposals always have a single option labelled
  /// "Approve" — we surface the label as-is so the UI can show the
  /// realm's chosen wording.
  singleChoiceLabel: string;
  /// Network the realm lives on.
  network: 'devnet' | 'mainnet';
  enabled: boolean;
};

// ─────────────────────────────────────────────────────────────────────
// Pinned realm: "testing realms wallet hasan"
//
// Verified live on api.devnet.solana.com 2026-04-26:
//   - Realm `779WgybS8G7YMnpt89eyDkPXmwjvSAq6XYVxExczdQzd`
//       acct_type=16 (RealmV2), name="testing realms wallet hasan"
//       community_mint=5DxcgJ8U1fB65R5zPCnWFFzLkAoh4e8amKKKK6hFMomo
//       council_mint  =44VSVc8xhutB6rD3P4z8GVskJrtJbMStbeZreMWCtTGt
//   - Governance `F9URP68DVs8FeXzgHPum5YdbnjJBtCFPYjS5PCYDy1Sn`
//       acct_type=18 (GovernanceV2)
//       voting_base_time = 259200 s (3 d)
//       voting_cool_off_time = 167772160 s (~5.3 y)
//       → proposal voting window stays open through 2027-12-23
//   - Proposal `7YWZL2uR9hjV5rL4reEN1a8TDxK68mrh7cAhHq9brycE`
//       acct_type=14 (ProposalV2), state=2 (Voting)
//       VoteType = SingleChoice (1 option)
//       option label = "Approve", deny_vote_weight = Some(0)
//       voting_at = 2022-08-26T09:08:25Z
//       governing_token_mint = council mint (44VSVc8x…)
//       proposal_owner_record = 6eZEdbkkdTyEARXdyEKZNWt76rC96GnNHYz3brxWg9eh
//
// The proposal is on the **council mint**, so a voter must have a TOR
// keyed on the council mint. Sprint 1 surfaces this in the UI as a
// gate: if the user has no TOR yet, point them at app.realms.today to
// deposit governing tokens before voting.
// ─────────────────────────────────────────────────────────────────────

const TESTING_REALMS_WALLET_HASAN: RealmsProposalEntry = {
  label: 'testing realms wallet hasan · grant #3',

  realmBs58: '779WgybS8G7YMnpt89eyDkPXmwjvSAq6XYVxExczdQzd',
  realmHex: pubkeyBs58ToBytes32('779WgybS8G7YMnpt89eyDkPXmwjvSAq6XYVxExczdQzd'),
  realmName: 'testing realms wallet hasan',

  governanceBs58: 'F9URP68DVs8FeXzgHPum5YdbnjJBtCFPYjS5PCYDy1Sn',
  governanceHex: pubkeyBs58ToBytes32(
    'F9URP68DVs8FeXzgHPum5YdbnjJBtCFPYjS5PCYDy1Sn',
  ),

  proposalBs58: '7YWZL2uR9hjV5rL4reEN1a8TDxK68mrh7cAhHq9brycE',
  proposalHex: pubkeyBs58ToBytes32(
    '7YWZL2uR9hjV5rL4reEN1a8TDxK68mrh7cAhHq9brycE',
  ),
  proposalName: 'Batched Payout — realms grant — 3 — Fri Aug 26 2022',
  proposalDescription: 'realms grant - 3',

  governingTokenMintBs58: '44VSVc8xhutB6rD3P4z8GVskJrtJbMStbeZreMWCtTGt',
  governingTokenMintHex: pubkeyBs58ToBytes32(
    '44VSVc8xhutB6rD3P4z8GVskJrtJbMStbeZreMWCtTGt',
  ),
  governingTokenLabel: 'council',

  proposalOwnerRecordBs58: '6eZEdbkkdTyEARXdyEKZNWt76rC96GnNHYz3brxWg9eh',
  proposalOwnerRecordHex: pubkeyBs58ToBytes32(
    '6eZEdbkkdTyEARXdyEKZNWt76rC96GnNHYz3brxWg9eh',
  ),

  hasDenyOption: true,
  voteType: 'single_choice',
  singleChoiceLabel: 'Approve',

  network: 'devnet',
  enabled: true,
};

export const REALMS_PROPOSAL_REGISTRY: ReadonlyArray<RealmsProposalEntry> = [
  TESTING_REALMS_WALLET_HASAN,
];

export const ENABLED_REALMS_PROPOSALS: ReadonlyArray<RealmsProposalEntry> =
  REALMS_PROPOSAL_REGISTRY.filter((p) => p.enabled);
