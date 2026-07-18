// `/vote` route — Cardo Realms governance.
//
// Sprint 1 ships a single pinned realm + proposal from
// `lib/realms-registry.ts`. The user picks Yes / No, signs one EVM tx,
// Rome's CPI precompile invokes SPL Governance's `cast_vote` as the
// user's PDA on Solana.
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md

'use client';

import { useCallback, useMemo } from 'react';
import { Vote } from '@/components/screens/Vote';
import { useWallet } from '../wallet-context';
import { ENABLED_REALMS_PROPOSALS } from '@/lib/realms-registry';
import { useRealmsProposalState } from '@/lib/use-realms-proposal-state';
import { useRealmsCastVote } from '@/lib/use-realms-cast-vote';
import type { RealmsVote } from '@/lib/realms-instructions';

type CastArgs = { kind: 'yes' | 'no' };

export default function Page() {
  const { wallet, connect } = useWallet();
  const proposal = ENABLED_REALMS_PROPOSALS[0];
  const proposalState = useRealmsProposalState(
    proposal ?? null,
    (wallet?.address as `0x${string}`) ?? undefined,
  );
  const { state: voteState, castVote } = useRealmsCastVote();

  const onCast = useCallback(
    (args: CastArgs) => {
      if (!wallet?.address) {
        connect?.();
        return;
      }
      if (!proposal) return;
      const vote: RealmsVote =
        args.kind === 'yes'
          ? {
              kind: 'yes',
              // Single-choice proposal → 1 option, full weight to it.
              choices: [{ rank: 0, weightPercentage: 100 }],
            }
          : { kind: 'no' };
      void castVote({
        userEvmAddress: wallet.address as `0x${string}`,
        proposal,
        vote,
      });
    },
    [wallet?.address, connect, proposal, castVote],
  );

  return (
    <Vote
      wallet={wallet}
      onConnect={connect}
      proposal={proposal}
      proposalState={proposalState}
      onCast={onCast}
      voteState={voteState}
    />
  );
}
