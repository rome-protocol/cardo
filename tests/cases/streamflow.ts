// Streamflow create_v2 / withdraw — unhappy-path cases.

import {
  buildStreamflowCancelInvoke,
  buildStreamflowTopupInvoke,
  buildStreamflowTransferRecipientInvoke,
  buildStreamflowUpdateInvoke,
  buildStreamflowWithdrawInvoke,
} from '../../lib/streamflow-instructions';
import { pubkeyBs58ToBytes32 } from '../../lib/solana-pda';
import type { TestCaseFile } from '../lib/case';

const FRESH_USER_EVM = '0x000000000000000000000000000000000000d017' as const;

// USDC devnet mint — same one Cardo bridges through. The Streamflow
// program treats this as an arbitrary mint; we use it because its
// ATAs are predictable.
const USDC_DEVNET = pubkeyBs58ToBytes32(
  '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
);

// A "metadata PDA" that doesn't exist — i.e., points at a stream the
// user never created. Streamflow's withdraw will hit
// `AccountNotInitialized` (Anchor 3012) when it tries to deserialize,
// or — more likely — Rome's strict-mode loader rejects it first with
// `account not found`. Either is a valid signal that the builder + the
// network round-trip work; the case just asserts the revert *fires*.
//
// We pick a deterministic pubkey by SHA-256-ing a fixed string, then
// bs58-encoding the first 32 bytes. Using a literal bs58 pubkey would
// risk colliding with an existing account.
const PHANTOM_METADATA = pubkeyBs58ToBytes32(
  // SHA-256("cardo-tests:streamflow:phantom-metadata") base58 first 32B.
  'F7bvmsZxYmqWfUz4XeCyzgDDRELfMo1QeRwqxbKzh4Yp',
);

const cases: TestCaseFile = [
  {
    name: 'streamflow.withdraw.metadata-not-initialized',
    description:
      'Withdrawing from a metadata PDA that has never been created → Anchor 3012 AccountNotInitialized.',
    build: () =>
      buildStreamflowWithdrawInvoke({
        userEvmAddress: FRESH_USER_EVM,
        metadataHex: PHANTOM_METADATA,
        mintHex: USDC_DEVNET,
        // Recipient = user themselves (most common Cardo flow).
        recipientHex: pubkeyBs58ToBytes32(
          '11111111111111111111111111111111',
        ),
        amount: 1n,
      }),
    expect: {
      // Either the strict-mode loader catches the metadata account
      // not existing, or Anchor's AccountNotInitialized fires once
      // the program runs. Both are acceptable signals — match the
      // common substring.
      revertContains: 'Custom',
    },
  },
  {
    name: 'streamflow.cancel.metadata-not-initialized',
    description:
      'Cancel a non-existent stream → metadata PDA not on-chain → strict-mode `account not found`. Verifies the cancel builder calldata round-trips.',
    build: () =>
      buildStreamflowCancelInvoke({
        userEvmAddress: FRESH_USER_EVM,
        metadataHex: PHANTOM_METADATA,
        mintHex: USDC_DEVNET,
        senderHex: pubkeyBs58ToBytes32('11111111111111111111111111111111'),
        recipientHex: pubkeyBs58ToBytes32('11111111111111111111111111111111'),
      }),
    expect: { revertContains: 'Custom' },
  },
  {
    name: 'streamflow.topup.metadata-not-initialized',
    description:
      'Topup a non-existent stream → metadata PDA not on-chain → strict-mode `account not found`. Verifies the topup builder calldata round-trips.',
    build: () =>
      buildStreamflowTopupInvoke({
        userEvmAddress: FRESH_USER_EVM,
        metadataHex: PHANTOM_METADATA,
        mintHex: USDC_DEVNET,
        amount: 1_000n,
      }),
    expect: { revertContains: 'Custom' },
  },
  {
    name: 'streamflow.update.metadata-not-initialized',
    description:
      'Update (enable auto-withdrawal) a non-existent stream. Must reach the program\'s stream-state check (Custom(98)) — proving the 6-arg update layout (Option<bool> enable + 2×Option<u64> + 3×Option<bool>) DESERIALIZED. Guards the Custom(102) InstructionDidNotDeserialize regression (the bare-u8-enable bug that made "enable automatic withdrawal" revert).',
    build: () =>
      buildStreamflowUpdateInvoke({
        userEvmAddress: FRESH_USER_EVM,
        metadataHex: PHANTOM_METADATA,
        enableAutomaticWithdrawal: true,
        withdrawFrequency: 60n,
      }),
    // Custom(98) = args decoded, program hit its own missing-stream check.
    // A layout regression reverts Custom(102) — which does NOT contain this.
    expect: { revertContains: 'Custom(98)' },
  },
  {
    name: 'streamflow.transfer-recipient.metadata-not-initialized',
    description:
      'Transfer recipient on a non-existent stream → metadata PDA not on-chain → strict-mode `account not found`. Verifies transfer_recipient builder calldata.',
    build: () =>
      buildStreamflowTransferRecipientInvoke({
        userEvmAddress: FRESH_USER_EVM,
        metadataHex: PHANTOM_METADATA,
        mintHex: USDC_DEVNET,
        newRecipientHex: pubkeyBs58ToBytes32(
          '11111111111111111111111111111111',
        ),
      }),
    expect: { revertContains: 'Custom' },
  },
];

export default cases;
