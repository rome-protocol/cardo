// Contract test (L1, hermetic): every lib/<family>-instructions.ts builder
// MUST have a tests/cases/<family>.ts unhappy-path case (the calldata-drift
// guard — CLAUDE.md "adapter pattern = builder + test"). This fails when a new
// builder lands without a test, so coverage can't silently regress.
//
// Runs in `npm test` → the pre-push hook AND CI. Closing a gap = add the case
// file and remove the name from ALLOWLIST (the allow-list self-ratchets: once
// a gap's case exists, its assertion flips and forces the entry's removal).
import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd(); // vitest runs from the repo root
const LIB = join(ROOT, 'lib');
const CASES = join(ROOT, 'tests', 'cases');

// Builder file stem → case file stem, where the two names differ.
const ALIAS: Record<string, string> = {
  'damm-v2': 'damm-v2-lp',
  'drift-spot': 'drift',
  pumpswap: 'pumpswap-lp',
  'spl-transfer': 'spl-token',
};

// Known, tracked coverage gaps. Do NOT grow this list — close gaps by adding
// the case file. Empty = every builder has a test. (The pumpfun gap from the
// 2026-06-28 adapters audit was closed: tests/cases/pumpfun.ts.)
const ALLOWLIST = new Set<string>([]);

const builders = readdirSync(LIB)
  .filter((f) => f.endsWith('-instructions.ts'))
  .map((f) => f.replace('-instructions.ts', ''));
const cases = new Set(
  readdirSync(CASES)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => f.replace('.ts', '')),
);

describe('contract: every instruction builder has a tests/cases test', () => {
  it('found builders and case files', () => {
    expect(builders.length).toBeGreaterThan(0);
    expect(cases.size).toBeGreaterThan(0);
  });

  for (const b of builders) {
    const expected = ALIAS[b] ?? b;
    if (ALLOWLIST.has(b)) {
      it(`${b} — KNOWN GAP (allow-listed): add tests/cases/${expected}.ts then drop from ALLOWLIST`, () => {
        // When the gap is closed (case file added), this flips — forcing the
        // allow-list entry to be removed so the list never goes stale.
        expect(cases.has(expected)).toBe(false);
      });
    } else {
      it(`${b} → tests/cases/${expected}.ts exists`, () => {
        expect(cases.has(expected)).toBe(true);
      });
    }
  }
});
