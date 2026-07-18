import { describe, it, expect } from 'vitest';
import { lamportsToSol, compactUsd, compactNum, safeRatio, readU64LE, stakePoolRate } from '../lib/stats-format';

describe('lamportsToSol', () => {
  it('converts bigint lamports to SOL', () => {
    expect(lamportsToSol(1_000_000_000n)).toBe(1);
    expect(lamportsToSol(2_500_000_000n)).toBe(2.5);
  });
  it('handles 0 / null', () => {
    expect(lamportsToSol(0n)).toBe(0);
    expect(lamportsToSol(null)).toBe(0);
  });
});

describe('compactNum / compactUsd — never dump a giant number', () => {
  it('compacts thousands/millions', () => {
    expect(compactNum(1234)).toBe('1.23K');
    expect(compactNum(1_500_000)).toBe('1.5M');
    expect(compactNum(2_300_000_000)).toBe('2.3B');
  });
  it('small numbers pass through', () => {
    expect(compactNum(42)).toBe('42');
    expect(compactNum(999)).toBe('999');
  });
  it('keeps decimals for small fractional amounts (does not round to 0)', () => {
    expect(compactNum(0.5)).toBe('0.5');
    expect(compactNum(4.23)).toBe('4.23');
    expect(compactNum(0.004)).toBe('0.004'); // tiny but non-zero must stay visible
    expect(compactNum(0)).toBe('0');
  });
  it('compactUsd prefixes $', () => {
    expect(compactUsd(1_500_000)).toBe('$1.5M');
    expect(compactUsd(0)).toBe('$0');
  });
});

describe('safeRatio — no NaN/Infinity from zero denominators', () => {
  it('divides', () => {
    expect(safeRatio(10, 4)).toBe(2.5);
  });
  it('returns null on zero/invalid denominator', () => {
    expect(safeRatio(10, 0)).toBeNull();
    expect(safeRatio(10, null)).toBeNull();
  });
});

describe('readU64LE — decode a u64 little-endian at a byte offset', () => {
  it('reads a known value at an offset', () => {
    const b = new Uint8Array(16);
    // 0x0102 = 258 at offset 8, little-endian
    b[8] = 0x02; b[9] = 0x01;
    expect(readU64LE(b, 8)).toBe(258n);
  });
  it('throws if the slice runs past the buffer', () => {
    expect(() => readU64LE(new Uint8Array(4), 0)).toThrow();
  });
});

describe('stakePoolRate — SOL/LST exchange rate from pool reserves', () => {
  it('computes lstPerSol + solPerLst (LST appreciates: solPerLst > 1)', () => {
    // 110 SOL backing 100 LST → 1 LST = 1.1 SOL, 1 SOL = 0.9090… LST
    const r = stakePoolRate(110_000_000_000n, 100_000_000_000n)!;
    expect(r.solPerLst).toBeCloseTo(1.1, 6);
    expect(r.lstPerSol).toBeCloseTo(0.90909, 4);
  });
  it('returns null when supply is zero', () => {
    expect(stakePoolRate(110n, 0n)).toBeNull();
  });
});
