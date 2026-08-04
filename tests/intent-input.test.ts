// Input-boundary guard for the natural-language intent endpoints.
//
// The keyless heuristic parser (parseIntentHeuristic) runs several regexes
// over user text. An unbounded body could drive polynomial backtracking
// (ReDoS) and stall the Node event loop, and the deployed pod runs keyless —
// so the heuristic path is the production parse. checkIntentText caps the
// input before it can reach any regex.

import { describe, expect, it } from 'vitest';
import {
  checkIntentText,
  MAX_INTENT_TEXT_LENGTH,
} from '../lib/orchestration/intent-input';

describe('checkIntentText', () => {
  it('accepts a normal intent', () => {
    const r = checkIntentText('swap 0.5 SOL to USDC then stake the rest');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe('swap 0.5 SOL to USDC then stake the rest');
  });

  it('trims surrounding whitespace', () => {
    const r = checkIntentText('  stake 1 SOL  ');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe('stake 1 SOL');
  });

  it('rejects empty / whitespace-only text with 400', () => {
    for (const raw of ['', '   ', '\n\t']) {
      const r = checkIntentText(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe(400);
    }
  });

  it('rejects a non-string body with 400', () => {
    const r = checkIntentText(undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('accepts text exactly at the cap', () => {
    const r = checkIntentText('a'.repeat(MAX_INTENT_TEXT_LENGTH));
    expect(r.ok).toBe(true);
  });

  it('rejects text over the cap with 413 (ReDoS guard)', () => {
    const r = checkIntentText('a'.repeat(MAX_INTENT_TEXT_LENGTH + 1));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(413);
      expect(r.error).toMatch(/too long/i);
    }
  });

  it('measures length AFTER trim (leading/trailing space does not count)', () => {
    const padded = '  ' + 'a'.repeat(MAX_INTENT_TEXT_LENGTH) + '  ';
    const r = checkIntentText(padded);
    expect(r.ok).toBe(true);
  });

  it('returns fast on a pathological oversized body (no regex runs)', () => {
    // A body crafted to backtrack the amount/compose regexes, but 10x the cap.
    const evil = ('9'.repeat(50) + ' ').repeat(400); // ~20k chars
    const start = performance.now();
    const r = checkIntentText(evil);
    const elapsedMs = performance.now() - start;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(413);
    expect(elapsedMs).toBeLessThan(50);
  });
});
