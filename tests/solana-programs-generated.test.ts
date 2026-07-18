// L1 — the committed lib/solana-programs.generated.json must match what the
// installed @rome-protocol/registry pin produces. Fails after a registry pin
// bump (or a registry content change) until `npm run build:solana-programs` is
// re-run, so a stale committed projection can never ship through CI.
import { describe, it, expect } from 'vitest';
import { generate } from '../scripts/build-solana-programs';
import committed from '../lib/solana-programs.generated.json';

describe('solana-programs.generated.json freshness', () => {
  it('matches the installed registry pin (regen: npm run build:solana-programs)', () => {
    // Round-trip through JSON so `undefined`-vs-absent and prototype
    // differences can't produce false mismatches.
    expect(JSON.parse(JSON.stringify(generate()))).toEqual(committed);
  });
});
