// Test-first: the swap quote must come from the POOL's reserves (constant
// product), not an oracle. Reserves below are the live wSOL/USDC pool read on
// Hadrian (26,763.76 wSOL : 203.19 USDC) — so 1 wSOL must quote ~0.0076 USDC,
// NOT the ~71 USDC the oracle implies. This is the math behind the displayed
// rate AND the enforced minimumOut.
import { describe, it, expect } from 'vitest';
import { constantProductOut, effectiveReserve } from '../lib/pool-quote';

const WSOL = 26_763_756_754_202n; // 9dp raw
const USDC = 203_193_082n; // 6dp raw

type Case = { name: string; got: bigint; min: bigint; max: bigint };
const cases: Case[] = [
  // 1 wSOL → USDC, 25 bps. ~0.007572 USDC (7572 raw, 6dp). NOT ~71e6.
  { name: 'wSOL→USDC pool price', got: constantProductOut(WSOL, USDC, 1_000_000_000n, 25), min: 7_400n, max: 7_700n },
  // 1 USDC → wSOL, 25 bps. ~130.7 wSOL (≈1.307e11 raw, 9dp).
  { name: 'USDC→wSOL pool price', got: constantProductOut(USDC, WSOL, 1_000_000n, 25), min: 129_000_000_000n, max: 132_000_000_000n },
  // fee reduces output: 0 bps must yield strictly more than 25 bps.
  { name: 'fee lowers output', got: constantProductOut(WSOL, USDC, 1_000_000_000n, 0) - constantProductOut(WSOL, USDC, 1_000_000_000n, 25), min: 1n, max: 1_000_000n },
  // guards → 0
  { name: 'zero amountIn', got: constantProductOut(WSOL, USDC, 0n, 25), min: 0n, max: 0n },
  { name: 'zero reserveIn', got: constantProductOut(0n, USDC, 1_000_000_000n, 25), min: 0n, max: 0n },
  { name: 'zero reserveOut', got: constantProductOut(WSOL, 0n, 1_000_000_000n, 25), min: 0n, max: 0n },
  // never exceeds reserveOut
  { name: 'bounded by reserveOut', got: constantProductOut(WSOL, USDC, 10n ** 20n, 25) <= USDC ? 1n : 0n, min: 1n, max: 1n },

  // ── effectiveReserve: the pool owns only its LP share of the shared vault ──
  // pool holds 1,000 LP of 100,000 supply over a 26,763e9 vault → 1% → 267.6e9
  { name: 'effReserve 1% share', got: effectiveReserve(1_000n, 26_763_756_754_202n, 100_000n), min: 267_000_000_000n, max: 268_000_000_000n },
  // share scales the reserve DOWN vs the raw vault balance (the bug we fixed)
  { name: 'effReserve < vault total', got: effectiveReserve(1_000n, 26_763_756_754_202n, 100_000n) < 26_763_756_754_202n ? 1n : 0n, min: 1n, max: 1n },
  { name: 'effReserve zero supply', got: effectiveReserve(1_000n, 26_763_756_754_202n, 0n), min: 0n, max: 0n },
  { name: 'effReserve zero balance', got: effectiveReserve(0n, 26_763_756_754_202n, 100_000n), min: 0n, max: 0n },
];

describe('poolQuote', () => {
  for (const c of cases) {
    it(c.name, () => {
      expect(
        c.got >= c.min && c.got <= c.max,
        `got ${c.got}, want [${c.min}, ${c.max}]`,
      ).toBe(true);
    });
  }
});
