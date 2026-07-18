// Shared formatting for on-chain stats (pool TVL/liquidity, exchange rates,
// user positions). Keeps stat math out of components and prevents the two
// classic bugs: NaN/Infinity from a zero denominator, and dumping a giant raw
// number into the UI. Pure functions — unit-tested in tests/stats-format.test.ts.

const LAMPORTS_PER_SOL = 1_000_000_000;

/** bigint lamports → SOL (number). null/undefined → 0. */
export function lamportsToSol(lamports: bigint | null | undefined): number {
  if (lamports == null) return 0;
  return Number(lamports) / LAMPORTS_PER_SOL;
}

/** Divide with a guard: a zero / null / non-finite denominator → null (so the
 *  caller renders "—" rather than NaN / Infinity). */
export function safeRatio(num: number, denom: number | null | undefined): number | null {
  if (denom == null || !Number.isFinite(denom) || denom === 0) return null;
  const r = num / denom;
  return Number.isFinite(r) ? r : null;
}

/** Compact a number for display: 1.23K / 1.5M / 2.3B for large values; small
 *  values keep up to ~3 significant decimals (never round a non-zero token
 *  amount down to "0"). */
export function compactNum(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return trim(n / 1e9) + 'B';
  if (abs >= 1e6) return trim(n / 1e6) + 'M';
  if (abs >= 1e3) return trim(n / 1e3) + 'K';
  if (n === 0) return '0';
  if (abs >= 1) return trim(n); // ≤2 decimals, trailing zeros stripped
  // sub-1: show up to 3 significant figures so tiny non-zero stays visible
  return parseFloat(n.toPrecision(3)).toString();
}

/** Compact USD: $1.5M / $0. */
export function compactUsd(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return '$' + compactNum(n).replace(/^-/, '-');
}

// Up to 2 decimals, trailing zeros stripped (1.2K not 1.20K; 1.23K kept).
function trim(n: number): string {
  return n
    .toFixed(2)
    .replace(/\.?0+$/, '');
}

/** Read a little-endian u64 at `offset` from a byte array (browser-safe; no
 *  Node Buffer). Throws if the 8-byte slice runs past the buffer. */
export function readU64LE(bytes: Uint8Array, offset: number): bigint {
  if (offset < 0 || offset + 8 > bytes.length) {
    throw new Error(`readU64LE: offset ${offset}+8 exceeds length ${bytes.length}`);
  }
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[offset + i]);
  return v;
}

/** SPL stake-pool exchange rate from its reserves (both 9-decimal, so the raw
 *  ratio is the rate directly). LST appreciates, so solPerLst > 1. null when
 *  the pool has no supply yet. */
export function stakePoolRate(
  totalLamports: bigint,
  poolTokenSupply: bigint,
): { lstPerSol: number; solPerLst: number } | null {
  if (poolTokenSupply <= 0n || totalLamports <= 0n) return null;
  const solPerLst = Number(totalLamports) / Number(poolTokenSupply);
  const lstPerSol = Number(poolTokenSupply) / Number(totalLamports);
  return { lstPerSol, solPerLst };
}
