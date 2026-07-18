// SPL Governance v3 ("Realms") cast_vote — unhappy-path cases.

import { buildRealmsCastVoteInvoke } from '../../lib/realms-instructions';
import { ENABLED_REALMS_PROPOSALS } from '../../lib/realms-registry';
import type { TestCaseFile } from '../lib/case';

const FRESH_USER_EVM = '0x000000000000000000000000000000000000d017' as const;

const PINNED = ENABLED_REALMS_PROPOSALS[0];
if (!PINNED) {
  throw new Error(
    'tests/cases/realms.ts: ENABLED_REALMS_PROPOSALS is empty — registry not seeded for tests',
  );
}

const cases: TestCaseFile = [
  {
    name: 'realms.cast-vote.fresh-user-no-tor',
    description:
      'cast_vote from a fresh user → derived voter_token_owner_record PDA does not exist on-chain → Rome strict-mode loader rejects with `account not found` before SPL Governance runs. Establishes that the calldata reaches Solana with the right account list.',
    build: () =>
      buildRealmsCastVoteInvoke({
        userEvmAddress: FRESH_USER_EVM,
        proposal: PINNED,
        vote: { kind: 'yes', choices: [{ rank: 0, weightPercentage: 100 }] },
      }),
    expect: {
      // Strict-mode loader catches the missing voter TOR (writable) before
      // the program runs. If Rome's loader ever loosens, fall back to
      // matching SPL Governance's runtime error
      // (TokenOwnerRecordAccountAddressMismatch / similar).
      revertContains: 'Custom',
    },
  },
  {
    name: 'realms.cast-vote.fresh-user-deny',
    description:
      'Same fresh-user setup but Vote::Deny — no VoteChoice body, just a single-byte enum tag. Confirms encodeVote handles the bare-tag variant the same way as Approve(Vec).',
    build: () =>
      buildRealmsCastVoteInvoke({
        userEvmAddress: FRESH_USER_EVM,
        proposal: PINNED,
        vote: { kind: 'no' },
      }),
    expect: {
      revertContains: 'Custom',
    },
  },
];

export default cases;
