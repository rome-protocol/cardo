// useRealmsCastVote — submit an SPL Governance `cast_vote` via Rome's
// CPI precompile.
//
// Single ix, signed by the user's Rome PDA. Caller passes the registry
// proposal entry + a Yes/No vote. Receipt poll mirrors
// useRaydiumCpmmSwap (Rome's wagmi `useWaitForTransactionReceipt` is
// flaky per playbook §4.10 — manual poll on `/api/rpc/rome`).

import { useCallback, useState } from 'react';
import { useRomeWrite } from './use-rome-write';
import type { Address, Hex } from 'viem';
import { CPI_INVOKE_ABI, CPI_PRECOMPILE } from './cpi-precompile';
import {
  buildRealmsCastVoteInvoke,
  type RealmsVote,
} from './realms-instructions';
import type { RealmsProposalEntry } from './realms-registry';

export type RealmsCastVotePhase =
  | 'idle'
  | 'signing'
  | 'confirming'
  | 'success'
  | 'failed';

export type RealmsCastVoteState = {
  phase: RealmsCastVotePhase;
  /// 'yes' or 'no' — which vote the user just cast (set the moment we
  /// transition to 'signing', so the screen can highlight the right
  /// button).
  vote?: 'yes' | 'no';
  hash?: Hex;
  error?: string;
};

const POLL_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 2_000;

async function waitForReceipt(
  hash: Hex,
): Promise<{ status: 'success' | 'reverted' }> {
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    try {
      const res = await fetch('/api/rpc/rome', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_getTransactionReceipt',
          params: [hash],
        }),
      });
      const json = await res.json();
      if (json.result?.blockNumber) {
        return {
          status: json.result.status === '0x1' ? 'success' : 'reverted',
        };
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[cardo realms-cast-vote] receipt poll error', e);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`receipt poll timed out for ${hash}`);
}

export function useRealmsCastVote() {
  const [state, setState] = useState<RealmsCastVoteState>({ phase: 'idle' });
  const { writeContractAsync } = useRomeWrite();

  const castVote = useCallback(
    async (opts: {
      userEvmAddress: Address;
      proposal: RealmsProposalEntry;
      vote: RealmsVote;
    }) => {
      const voteLabel = opts.vote.kind === 'yes' ? 'yes' : 'no';
      setState({ phase: 'idle', vote: voteLabel });
      try {
        const built = buildRealmsCastVoteInvoke(opts);
        setState({ phase: 'signing', vote: voteLabel });
        const hash = await writeContractAsync({
          address: CPI_PRECOMPILE,
          abi: CPI_INVOKE_ABI,
          functionName: 'invoke',
          args: [built.program, built.accounts, built.data],
        });
        setState({ phase: 'confirming', vote: voteLabel, hash });
        const r = await waitForReceipt(hash);
        if (r.status === 'reverted') {
          setState({
            phase: 'failed',
            vote: voteLabel,
            hash,
            error:
              'cast_vote reverted. Common causes: caller has no TOR for this realm + governing mint, voting window expired (ProposalVotingTimeExpired), already voted on this proposal (VoteAlreadyExists), or the realm requires a voter-weight addin we are not passing.',
          });
          return;
        }
        setState({ phase: 'success', vote: voteLabel, hash });
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        setState((prev) => ({ ...prev, phase: 'failed', error: msg }));
      }
    },
    [writeContractAsync],
  );

  const reset = useCallback(() => setState({ phase: 'idle' }), []);
  return { state, castVote, reset } as const;
}
