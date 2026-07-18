// Test-first: the LIVE mapping layer between the existence probes and the
// pure signaturePlan. statusToFlag turns a probe's tri-state
// ('unknown'|'exists'|'missing') into the optimistic boolean|undefined the
// plan expects; liveAccountState picks WHICH probe feeds WHICH flag per flow.
//
// This is the decision logic the useSignaturePlan hook wraps. The hook
// plumbing (polling, React state) is render-verified in the browser, not here.
import { describe, it, expect } from 'vitest';
import { statusToFlag, liveAccountState } from '../lib/signature-plan-live';
import { signatureCount } from '../lib/signature-plan';

type Case = { name: string; got: unknown; want: unknown };
const cases: Case[] = [
  // ── statusToFlag: tri-state → optimistic boolean|undefined ──
  { name: 'statusToFlag exists',  got: statusToFlag('exists'),  want: true },
  { name: 'statusToFlag missing', got: statusToFlag('missing'), want: false },
  { name: 'statusToFlag unknown', got: statusToFlag('unknown'), want: undefined },
  { name: 'statusToFlag absent',  got: statusToFlag(undefined), want: undefined },

  // ── swap: ATA status drives count; unknown stays optimistic (1, no flash) ──
  { name: 'swap ata missing → 2', got: signatureCount('swap', liveAccountState('swap', { ataStatus: 'missing' })), want: 2 },
  { name: 'swap ata exists → 1',  got: signatureCount('swap', liveAccountState('swap', { ataStatus: 'exists' })),  want: 1 },
  { name: 'swap ata unknown → 1', got: signatureCount('swap', liveAccountState('swap', { ataStatus: 'unknown' })), want: 1 },

  // ── stake: same ATA-driven shape as swap ──
  { name: 'stake ata missing → 2', got: signatureCount('stake', liveAccountState('stake', { ataStatus: 'missing' })), want: 2 },
  { name: 'stake ata exists → 1',  got: signatureCount('stake', liveAccountState('stake', { ataStatus: 'exists' })),  want: 1 },

  // ── send: recipient ATA drives count ──
  { name: 'send recip missing → 2', got: signatureCount('send', liveAccountState('send', { ataStatus: 'missing' })), want: 2 },
  { name: 'send recip exists → 1',  got: signatureCount('send', liveAccountState('send', { ataStatus: 'exists' })),  want: 1 },

  // ── kamino: metadata + obligation each gate a setup step ──
  { name: 'kamino both missing → 3', got: signatureCount('lend-kamino', liveAccountState('lend-kamino', { kaminoMetaStatus: 'missing', kaminoOblStatus: 'missing' })), want: 3 },
  { name: 'kamino meta only → 2',    got: signatureCount('lend-kamino', liveAccountState('lend-kamino', { kaminoMetaStatus: 'exists',  kaminoOblStatus: 'missing' })), want: 2 },
  { name: 'kamino both exist → 1',   got: signatureCount('lend-kamino', liveAccountState('lend-kamino', { kaminoMetaStatus: 'exists',  kaminoOblStatus: 'exists'  })), want: 1 },
  { name: 'kamino unknown → 1',      got: signatureCount('lend-kamino', liveAccountState('lend-kamino', { kaminoMetaStatus: 'unknown', kaminoOblStatus: 'unknown' })), want: 1 },

  // ── drift: booleans, but loading must read as "unknown" (optimistic 1) ──
  { name: 'drift fresh → 3',    got: signatureCount('lend-drift', liveAccountState('lend-drift', { driftLoading: false, driftStatsExists: false, driftUserExists: false })), want: 3 },
  { name: 'drift stats only → 2', got: signatureCount('lend-drift', liveAccountState('lend-drift', { driftLoading: false, driftStatsExists: true, driftUserExists: false })), want: 2 },
  { name: 'drift warm → 1',     got: signatureCount('lend-drift', liveAccountState('lend-drift', { driftLoading: false, driftStatsExists: true, driftUserExists: true })), want: 1 },
  { name: 'drift loading → 1',  got: signatureCount('lend-drift', liveAccountState('lend-drift', { driftLoading: true, driftStatsExists: false, driftUserExists: false })), want: 1 },

  // ── streamflow: genuinely 1 regardless of any readings ──
  { name: 'pay always → 1', got: signatureCount('pay-streamflow', liveAccountState('pay-streamflow', { ataStatus: 'missing' })), want: 1 },
];

describe('signaturePlanLive', () => {
  for (const c of cases) {
    it(c.name, () => {
      expect(c.got).toBe(c.want);
    });
  }
});
