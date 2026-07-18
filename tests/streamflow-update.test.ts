// Deterministic (network-free) guard for the Streamflow `update` calldata
// layout — the exact bug behind the user-reported "enable automatic withdrawal" revert
// (Custom(102) InstructionDidNotDeserialize). The program's on-chain IDL says
// update takes SIX args: Option<bool> enable, Option<u64> withdraw_frequency,
// Option<u64> amount_per_period, Option<bool> ×3 (transferable/cancelable).
// An earlier build emitted `enable` as a bare u8 (1 byte) → every field after
// mis-aligned → 102. This pins the wire bytes so that never regresses.

import { describe, expect, it } from 'vitest';
import { buildStreamflowUpdateInvoke } from '../lib/streamflow-instructions';
import { pubkeyBs58ToBytes32 } from '../lib/solana-pda';
import {
  AUTO_WITHDRAW_FREQUENCY_SECONDS,
  SAFE_MAX_SCHEDULED_WITHDRAWALS,
  scheduledWithdrawals,
} from '../lib/streamflow-program';

// Longest stream the /pay UI offers.
const MAX_STREAM_DURATION_SECONDS = 7_776_000n; // 3 months

const USER = '0x000000000000000000000000000000000000d017' as const;
const META = pubkeyBs58ToBytes32('F7bvmsZxYmqWfUz4XeCyzgDDRELfMo1QeRwqxbKzh4Yp');

// args = calldata after the 8-byte (16-hex) instruction discriminator.
const args = (data: string) => data.slice(2 + 16).toLowerCase();

describe('streamflow update calldata layout (Custom(102) regression guard)', () => {
  it('enable auto-withdrawal + frequency → Some(true) | Some(60 u64le) | None×4', () => {
    const inv = buildStreamflowUpdateInvoke({
      userEvmAddress: USER,
      metadataHex: META,
      enableAutomaticWithdrawal: true,
      withdrawFrequency: 60n,
    });
    // Option<bool> Some(true)=0101 | Option<u64> Some(60)=01 3c…00 | 4× None=00
    expect(args(inv.data)).toBe('0101013c0000000000000000000000');
  });

  it('all-undefined → six 0x00 option tags (never a bare byte)', () => {
    const inv = buildStreamflowUpdateInvoke({ userEvmAddress: USER, metadataHex: META });
    expect(args(inv.data)).toBe('000000000000');
  });
});

// Auto-withdrawal cadence guard — the "enable automatic withdrawal reverts
// InsufficientFunds on long streams" bug. Enabling schedules
// ~duration/withdrawFrequency crank withdrawals; too many → the enable tx
// reverts. Proven on Hadrian→Streamflow devnet against a real 3-month stream:
// enable @ 60s cadence FAILED (Failure(InsufficientFunds)); enable @ 86,400s
// (daily) SUCCEEDED. This pins the app cadence into the safe range.
describe('streamflow auto-withdrawal cadence (InsufficientFunds regression guard)', () => {
  it('app cadence keeps the max (3-month) stream within the safe withdrawal count', () => {
    const count = scheduledWithdrawals(MAX_STREAM_DURATION_SECONDS);
    expect(count).toBe(90n); // 7_776_000 / 86_400
    expect(count).toBeLessThan(SAFE_MAX_SCHEDULED_WITHDRAWALS);
  });

  it('the old per-vesting-period (60s) cadence would blow past the safe count (the bug)', () => {
    const bad = scheduledWithdrawals(MAX_STREAM_DURATION_SECONDS, 60n);
    expect(bad).toBe(129_600n); // the value that reverted InsufficientFunds live
    expect(bad).toBeGreaterThan(SAFE_MAX_SCHEDULED_WITHDRAWALS);
  });

  it('the app cadence is coarse (not the 60s vesting period)', () => {
    expect(AUTO_WITHDRAW_FREQUENCY_SECONDS).toBeGreaterThanOrEqual(3_600n);
  });
});
