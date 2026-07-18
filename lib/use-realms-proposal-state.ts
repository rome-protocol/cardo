// Live state for the Cardo `/vote` page:
//   - proposal voting window open?
//   - caller already cast a vote on this proposal?
//   - caller has a TokenOwnerRecord for the realm + governing mint?
//
// All three checks happen client-side via the cardo proxy
// (`/api/rpc/solana-devnet`); none of them sign anything.

import { useEffect, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import type { Hex } from 'viem';
import { bytes32ToPublicKey, deriveRomeUserPda } from './solana-pda';
import { deriveRealmsCastVoteAddresses } from './realms-pdas';
import type { RealmsProposalEntry } from './realms-registry';
import { ACCOUNT_TYPE_PROPOSAL_V2 } from './realms-program';

const RPC = '/api/rpc/solana-devnet';
const POLL_MS = 12_000;

export type RealmsProposalLiveState = {
  loading: boolean;
  /// Proposal account read OK?
  proposalExists: boolean;
  /// Current proposal state (Voting=2, Succeeded=3, Defeated=7, etc.).
  proposalState: number | null;
  /// Voting window, in seconds since unix epoch. Both pulled from the
  /// proposal + its parent governance account.
  votingAt: number | null;
  voteEndsAt: number | null;
  /// `true` iff `now < voteEndsAt`.
  isOpen: boolean;
  /// Caller's TokenOwnerRecord existence on this realm + mint. Required
  /// for cast_vote — without it the program rejects.
  callerHasTor: boolean;
  /// Caller's vote-record account. If non-null, the user already voted
  /// on this proposal and a re-vote will revert with VoteAlreadyExists.
  callerHasVoted: boolean;
  error?: string;
};

const EMPTY: RealmsProposalLiveState = {
  loading: true,
  proposalExists: false,
  proposalState: null,
  votingAt: null,
  voteEndsAt: null,
  isOpen: false,
  callerHasTor: false,
  callerHasVoted: false,
};

function bs58FromHex(h: Hex): string {
  const clean = h.startsWith('0x') ? h.slice(2) : h;
  return new PublicKey(Buffer.from(clean, 'hex')).toBase58();
}

/// Decode a ProposalV2's `voting_at: Option<i64>` field. Walks past the
/// variable-size header to find the field. Mirrors the off-chain
/// research script verified live 2026-04-26.
function decodeProposalVotingAt(buf: Buffer): {
  state: number;
  votingAt: number | null;
} | null {
  if (buf.length < 100 || buf[0] !== ACCOUNT_TYPE_PROPOSAL_V2) return null;
  let off = 0;
  off += 1; // acct_type
  off += 32; // governance
  off += 32; // governing_token_mint
  const state = buf[off];
  off += 1;
  off += 32; // token_owner_record (proposer)
  off += 1; // signatories_count
  off += 1; // signatories_signed_off_count
  // VoteType (Borsh enum):
  //   tag 0 = SingleChoice  (0 bytes body)
  //   tag 1 = MultiChoice { choice_type: u8, min: u8, max: u8, max_winning: u8 }
  const voteTypeTag = buf[off];
  off += 1;
  if (voteTypeTag === 1) off += 4;
  else if (voteTypeTag !== 0) return null;
  // Vec<ProposalOption>
  const optCount = buf.readUInt32LE(off);
  off += 4;
  for (let i = 0; i < optCount; i++) {
    const lblLen = buf.readUInt32LE(off);
    off += 4 + lblLen;
    off += 8; // vote_weight u64
    off += 1; // vote_result u8
    off += 2 + 2 + 2; // tx_executed_count + tx_count + tx_next_index
  }
  // deny_vote_weight: Option<u64>
  if (buf[off++] === 1) off += 8;
  off += 1; // reserved1 u8
  // abstain_vote_weight: Option<u64>
  if (buf[off++] === 1) off += 8;
  // start_voting_at: Option<i64>
  if (buf[off++] === 1) off += 8;
  off += 8; // draft_at i64
  // signing_off_at: Option<i64>
  if (buf[off++] === 1) off += 8;
  // voting_at: Option<i64>
  const votingAtTag = buf[off];
  off += 1;
  let votingAt: number | null = null;
  if (votingAtTag === 1) {
    votingAt = Number(buf.readBigInt64LE(off));
    off += 8;
  }
  return { state, votingAt };
}

/// Decode a GovernanceV2's voting timing config. The GovernanceConfig
/// inner struct lives at offset 69 (1 acct_type + 32 realm + 32 seed +
/// 4 reserved1). VoteThreshold variants are variable-length:
///   tag 0 = YesVotePercentage(u8)  → 1 + 1 = 2 bytes
///   tag 1 = QuorumPercentage(u8)   → 1 + 1 = 2 bytes
///   tag 2 = Disabled               → 1 byte
function decodeGovernanceTiming(
  buf: Buffer,
): { votingBaseTime: number; votingCoolOffTime: number } | null {
  // SPL Governance has 4 V2 governance variants that share the same
  // GovernanceConfig layout — only the leading account_type discriminator
  // differs:
  //   18 = GovernanceV2          (the original, generic governance)
  //   19 = ProgramGovernanceV2   (governs an upgradeable program)
  //   20 = MintGovernanceV2      (governs a token mint)   ← our pinned realm
  //   21 = TokenGovernanceV2     (governs an SPL token account)
  // Restricting to 18 only made the registry's MintGovernance reject;
  // accept any of the four.
  if (buf.length < 100) return null;
  const acctType = buf[0];
  if (acctType !== 18 && acctType !== 19 && acctType !== 20 && acctType !== 21)
    return null;
  let off = 69;
  const skipVT = (): boolean => {
    const tag = buf[off++];
    if (tag === 0 || tag === 1) {
      off += 1; // inner u8
      return true;
    }
    if (tag === 2) return true;
    return false;
  };
  if (!skipVT()) return null; // community_vote_threshold
  off += 8; // min_community_weight_to_create_proposal
  off += 4; // transactions_hold_up_time
  const votingBaseTime = buf.readUInt32LE(off);
  off += 4;
  off += 1; // community_vote_tipping
  if (!skipVT()) return null; // council_vote_threshold
  if (!skipVT()) return null; // council_veto_vote_threshold
  off += 8; // min_council_weight_to_create_proposal
  off += 1; // council_vote_tipping
  if (!skipVT()) return null; // community_veto_vote_threshold
  const votingCoolOffTime = buf.readUInt32LE(off);
  return { votingBaseTime, votingCoolOffTime };
}

export function useRealmsProposalState(
  proposal: RealmsProposalEntry | null,
  userEvmAddress: Hex | undefined,
): RealmsProposalLiveState {
  const [state, setState] = useState<RealmsProposalLiveState>(EMPTY);

  useEffect(() => {
    if (!proposal) {
      setState({ ...EMPTY, loading: false });
      return;
    }
    let cancelled = false;

    const tick = async () => {
      try {
        const userPda = userEvmAddress
          ? deriveRomeUserPda(userEvmAddress)
          : null;
        const addrs = userPda
          ? deriveRealmsCastVoteAddresses({
              userPdaHex: userPda,
              realmHex: proposal.realmHex,
              proposalHex: proposal.proposalHex,
              governingTokenMintHex: proposal.governingTokenMintHex,
            })
          : null;

        // Fetch the proposal + governance + (caller TOR + caller vote
        // record) in one batch.
        const accountsToFetch: string[] = [
          proposal.proposalBs58,
          proposal.governanceBs58,
        ];
        if (addrs) {
          accountsToFetch.push(bs58FromHex(addrs.voterTokenOwnerRecord));
          accountsToFetch.push(bs58FromHex(addrs.voteRecord));
        }
        const r = await fetch(RPC, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getMultipleAccounts',
            params: [accountsToFetch, { encoding: 'base64' }],
          }),
        });
        const j = await r.json();
        const vs: Array<{ data: [string, 'base64'] } | null> =
          j?.result?.value ?? [];

        const propVal = vs[0];
        const govVal = vs[1];
        const torVal = vs[2] ?? null;
        const voteRecordVal = vs[3] ?? null;

        if (!propVal || !govVal) {
          if (!cancelled)
            setState({
              ...EMPTY,
              loading: false,
              error: 'proposal or governance account missing',
            });
          return;
        }

        const propBuf = Buffer.from(propVal.data[0], 'base64');
        const propDecoded = decodeProposalVotingAt(propBuf);
        if (!propDecoded) {
          if (!cancelled)
            setState({
              ...EMPTY,
              loading: false,
              error: 'failed to decode proposal',
            });
          return;
        }

        const govBuf = Buffer.from(govVal.data[0], 'base64');
        const govDecoded = decodeGovernanceTiming(govBuf);
        if (!govDecoded) {
          if (!cancelled)
            setState({
              ...EMPTY,
              loading: false,
              error: 'failed to decode governance timing',
            });
          return;
        }

        const now = Math.floor(Date.now() / 1000);
        const voteEndsAt =
          propDecoded.votingAt != null
            ? propDecoded.votingAt +
              govDecoded.votingBaseTime +
              govDecoded.votingCoolOffTime
            : null;
        const isOpen =
          propDecoded.state === 2 &&
          voteEndsAt != null &&
          voteEndsAt > now;

        if (cancelled) return;
        setState({
          loading: false,
          proposalExists: true,
          proposalState: propDecoded.state,
          votingAt: propDecoded.votingAt,
          voteEndsAt,
          isOpen,
          callerHasTor: !!torVal,
          callerHasVoted: !!voteRecordVal,
        });
      } catch (e) {
        if (!cancelled)
          setState({
            ...EMPTY,
            loading: false,
            error: (e as Error).message ?? String(e),
          });
      }
    };

    void tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [proposal, userEvmAddress]);

  return state;
}
