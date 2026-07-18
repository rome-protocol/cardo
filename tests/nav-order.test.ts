import { describe, it, expect } from 'vitest';
import { CATEGORIES, VENUES, categoryOf } from '../components/design/nav-config';

describe('orchestrator is reachable from the nav', () => {
  it('exposes an Orchestrator category pointing at /orchestrator', () => {
    // The working Jupiter perp (+ swap/stake/yield/compose intents) lives in
    // /orchestrator; before this it had no nav link and was URL-only. Guard
    // that it stays discoverable.
    const orch = CATEGORIES.find((c) => c.href === '/orchestrator');
    expect(orch).toBeDefined();
    expect(orch?.label.toLowerCase()).toContain('orchestrat');
  });

  it('maps /orchestrator to its own category for active-state highlight', () => {
    expect(categoryOf('/orchestrator')).toBe('orchestrator');
  });
});

describe('venue ordering', () => {
  it('lists Mango first under Lend', () => {
    // Operator: Mango is the primary lend venue (Kamino lend is currently broken),
    // so it must lead the venue bar — not sit third.
    expect(VENUES.lend[0].label).toBe('Mango');
  });

  it('does not surface routes that cannot work in-UI yet', () => {
    // "If it cannot work, remove it":
    //  - Kamino (/lend): supply/borrow write unwired.
    //  - Pump.fun (/swap-pumpfun) + PumpSwap (/swap-pumpswap): need a user mint
    //    to load a pool, so they can't quote in-UI without an external paste.
    // Guard against re-adding any of them before they're self-contained.
    const allHrefs = Object.values(VENUES).flat().map((v) => v.href);
    expect(allHrefs).not.toContain('/lend');
    expect(allHrefs).not.toContain('/swap-pumpfun');
    expect(allHrefs).not.toContain('/swap-pumpswap');
  });

  it("each multi-venue category's top-nav default points at its first venue", () => {
    // Invariant: clicking the action in the top bar lands you on the first venue.
    for (const c of CATEGORIES) {
      const vs = VENUES[c.key];
      if (vs) expect(c.href).toBe(vs[0].href);
    }
  });
});
