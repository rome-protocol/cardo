// L1 — the committed lib/chain-config.generated.json must match what the
// installed @rome-protocol/registry pin produces. Fails after a registry pin
// bump (or a registry content change) until `npm run build:chain-config` is
// re-run, so a stale committed projection can never ship through CI.
import { describe, it, expect } from 'vitest';
import { generate } from '../scripts/build-chain-config';
import committed from '../lib/chain-config.generated.json';

describe('chain-config.generated.json freshness', () => {
  it('matches the installed registry pin (regen: npm run build:chain-config)', () => {
    // Round-trip through JSON so `undefined`-vs-absent and prototype
    // differences can't produce false mismatches.
    expect(JSON.parse(JSON.stringify(generate()))).toEqual(committed);
  });
});
