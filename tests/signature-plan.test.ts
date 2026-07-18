// Test-first: signaturePlan must return the REAL ordered signature steps
// for each flow given on-chain account state, matching the grounding pass.
import { describe, it, expect } from 'vitest';
import { signaturePlan } from '../lib/signature-plan';

type Case = { name: string; flow: string; state: any; wantCount: number; wantSetup: number };
const cases: Case[] = [
  // Swap: warm (output ATA exists) = 1; fresh = 2 (create ATA + swap)
  { name: 'swap warm',  flow: 'swap',  state: { outAtaExists: true },  wantCount: 1, wantSetup: 0 },
  { name: 'swap fresh', flow: 'swap',  state: { outAtaExists: false }, wantCount: 2, wantSetup: 1 },
  // Kamino: fresh = 3 (metadata + obligation + supply); warm = 1
  { name: 'kamino fresh', flow: 'lend-kamino', state: { kaminoMetadataExists: false, kaminoObligationExists: false }, wantCount: 3, wantSetup: 2 },
  { name: 'kamino warm',  flow: 'lend-kamino', state: { kaminoMetadataExists: true,  kaminoObligationExists: true  }, wantCount: 1, wantSetup: 0 },
  { name: 'kamino half',  flow: 'lend-kamino', state: { kaminoMetadataExists: true,  kaminoObligationExists: false }, wantCount: 2, wantSetup: 1 },
  // Drift: fresh = 3 (stats + user + deposit); warm = 1
  { name: 'drift fresh', flow: 'lend-drift', state: { driftStatsExists: false, driftUserExists: false }, wantCount: 3, wantSetup: 2 },
  { name: 'drift warm',  flow: 'lend-drift', state: { driftStatsExists: true,  driftUserExists: true  }, wantCount: 1, wantSetup: 0 },
  // Stake: warm 1 / fresh 2 (create stake-token ATA)
  { name: 'stake warm',  flow: 'stake', state: { outAtaExists: true },  wantCount: 1, wantSetup: 0 },
  { name: 'stake fresh', flow: 'stake', state: { outAtaExists: false }, wantCount: 2, wantSetup: 1 },
  // Pay Streamflow: always 1 (ATAs inline, no ephemeral signer)
  { name: 'pay any', flow: 'pay-streamflow', state: {}, wantCount: 1, wantSetup: 0 },
  // Send: warm 1 / fresh 2 (recipient ATA)
  { name: 'send warm',  flow: 'send', state: { recipientAtaExists: true },  wantCount: 1, wantSetup: 0 },
  { name: 'send fresh', flow: 'send', state: { recipientAtaExists: false }, wantCount: 2, wantSetup: 1 },
];

describe('signaturePlan', () => {
  for (const c of cases) {
    it(c.name, () => {
      const steps = signaturePlan(c.flow as any, c.state);
      expect(steps.length, 'count').toBe(c.wantCount);
      expect(steps.filter((s) => s.setup).length, 'setup').toBe(c.wantSetup);
      expect(steps[steps.length - 1]?.atomic, 'last step atomic').toBe(true);
    });
  }
});
