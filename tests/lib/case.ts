// Shared `TestCase` shape used by every file under `tests/cases/`.
//
// Each case is a pure-function build → emulate → assert triple. The
// runner walks the array, calls `build()` to produce a CPI invoke,
// signs the EVM tx with the shared treasury, fires `rome_emulateTx`,
// and matches the resulting `revertReason` against the expected
// substring.
//
// New protocols add a file under `tests/cases/<protocol>.ts` that
// default-exports an array of these. See `tests/CLAUDE.md` for the
// step-by-step add-a-test convention.

import type { Hex } from 'viem';
import type { Invoke } from './emulate';

export type TestCase = {
  /// Dotted name "<protocol>.<action>.<scenario>", e.g.
  /// "drift.deposit.no-tokens". The first segment groups under
  /// `--filter=<protocol>`.
  name: string;
  /// One-line human description of why this case fails.
  description: string;
  /// Pure builder for a CPI-invoke case. Must NOT touch the network.
  /// Returns the same `{program, accounts, data}` shape
  /// `lib/<protocol>-instructions.ts` produces. Mutually exclusive with
  /// `buildRaw` (provide exactly one).
  build?: () => Invoke;
  /// Pure builder for a RAW-precompile case — a direct EVM tx to a
  /// precompile address with raw calldata (not the CPI `invoke(...)`
  /// shape). Used by the wrap/unwrap legs (Withdraw 0x42..16 /
  /// HelperProgram 0xff..09). Mutually exclusive with `build`.
  buildRaw?: () => { to: Hex; data: Hex };
  /// Optional override — if set, run this case as a different EVM
  /// signer than the shared treasury. v1 leaves this unset for every
  /// case; reserved for future "user-with-state" scenarios that need
  /// a known PDA on chain.
  signerPk?: `0x${string}`;
  /// Optional override gas limit. Useful only for "out of gas" tests.
  gasLimit?: bigint;
  /// Expected outcome.
  expect:
    | {
        /// `revertReason` (or any log line, lowercased) must contain
        /// this substring (case-insensitive).
        revertContains: string;
      }
    | {
        /// Treat success (no revert) as the expected outcome. Rare —
        /// we're an unhappy-path harness — but useful as a smoke
        /// case ("the builder works at all").
        success: true;
      };
};

export type TestCaseFile = TestCase[];
