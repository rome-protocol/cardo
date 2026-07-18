// Test-first: Orca spot quote from the live whirlpool sqrtPrice. Values below
// are the live Hadrian-devnet WSOL/USDC whirlpool read on-chain:
//   sqrtPriceX64 = 1867208270439012581, tick = -45812 → ~10.24 USDC per WSOL.
// So 1 WSOL (9dp) → ~10.24 USDC (6dp); 1 USDC → ~0.0976 WSOL. Fee 300 ppm.
import { describe, it, expect } from 'vitest';
import { orcaSpotOut, orcaMinOut } from '../lib/orca-quote';

const SQRT = 1_867_208_270_439_012_581n;

type Case = { name: string; got: bigint; min: bigint; max: bigint };
const cases: Case[] = [
  // 1 WSOL → USDC : ~10.24 USDC (6dp) ≈ 10_240_000 raw
  { name: 'aToB WSOL→USDC', got: orcaSpotOut(SQRT, true, 1_000_000_000n, 300), min: 10_100_000n, max: 10_400_000n },
  // 1 USDC → WSOL : ~0.0976 WSOL (9dp) ≈ 97.6e6 raw
  { name: 'bToA USDC→WSOL', got: orcaSpotOut(SQRT, false, 1_000_000n, 300), min: 96_000_000n, max: 99_000_000n },
  // fee lowers output (300 ppm vs 0)
  { name: 'fee lowers output', got: orcaSpotOut(SQRT, true, 1_000_000_000n, 0) - orcaSpotOut(SQRT, true, 1_000_000_000n, 300), min: 1n, max: 100_000n },
  // guards
  { name: 'zero amountIn', got: orcaSpotOut(SQRT, true, 0n, 300), min: 0n, max: 0n },
  { name: 'zero sqrtPrice', got: orcaSpotOut(0n, true, 1_000_000_000n, 300), min: 0n, max: 0n },
  // minOut applies slippage
  { name: 'minOut 0.5%', got: orcaMinOut(10_000_000n, 50), min: 9_950_000n, max: 9_950_000n },
  { name: 'minOut zero', got: orcaMinOut(0n, 50), min: 0n, max: 0n },
];

describe('orcaQuote', () => {
  for (const c of cases) {
    it(c.name, () => {
      expect(
        c.got >= c.min && c.got <= c.max,
        `got ${c.got}, want [${c.min}, ${c.max}]`,
      ).toBe(true);
    });
  }
});
