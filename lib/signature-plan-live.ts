// Live mapping layer: turn the existence probes' readings into the
// AccountState that the pure signaturePlan consumes.
//
// The probes (useAtaExists, useKaminoUserMetadataExists / Obligation) report a
// tri-state — 'unknown' | 'exists' | 'missing' — while still loading or after a
// read. useDriftSpotInitState reports booleans plus a `loading` flag (its
// booleans default to false during load). Both shapes funnel through here into
// the optimistic boolean | undefined that signaturePlan expects:
//   exists  → true   (account is there; no setup step)
//   missing → false  (account absent; signaturePlan adds the setup step)
//   unknown → undefined → treated as "already set up" so the ledger never
//             flashes a phantom setup row while the probe is still in flight.
//
// This module is PURE (no React, no imports from the hook files) so the
// decision logic is unit-tested directly; the useSignaturePlan hook wires the
// live probes into liveAccountState and is render-verified in the browser.

import type { AccountState, FlowKind } from './signature-plan';

/** The tri-state both the ATA and Kamino probes report. */
export type ProbeStatus = 'unknown' | 'exists' | 'missing';

/** Raw probe outputs collected by the hook, before flow-specific routing. */
export type ProbeReadings = {
  /** useAtaExists.status — the receive/recipient ATA (swap, stake, send). */
  ataStatus?: ProbeStatus;
  /** useKaminoUserMetadataExists.status — per-user lending account. */
  kaminoMetaStatus?: ProbeStatus;
  /** useKaminoObligationExists.status — per-market obligation. */
  kaminoOblStatus?: ProbeStatus;
  /** useDriftSpotInitState.loading — booleans below are unreliable while true. */
  driftLoading?: boolean;
  driftStatsExists?: boolean;
  driftUserExists?: boolean;
};

/** Tri-state → optimistic flag: only a KNOWN-missing account adds a step. */
export function statusToFlag(status?: ProbeStatus): boolean | undefined {
  if (status === 'exists') return true;
  if (status === 'missing') return false;
  return undefined; // 'unknown' or absent → optimistic (no invented setup step)
}

/** Route the readings to the flags this flow's signaturePlan actually reads. */
export function liveAccountState(flow: FlowKind, r: ProbeReadings): AccountState {
  switch (flow) {
    case 'swap':
    case 'stake':
      // Both gate on the user's receive-token ATA.
      return { outAtaExists: statusToFlag(r.ataStatus) };
    case 'send':
      // Gates on the recipient's ATA (probe is fed the recipient address).
      return { recipientAtaExists: statusToFlag(r.ataStatus) };
    case 'lend-kamino':
      return {
        kaminoMetadataExists: statusToFlag(r.kaminoMetaStatus),
        kaminoObligationExists: statusToFlag(r.kaminoOblStatus),
      };
    case 'lend-drift':
      // Drift reports booleans; while loading they default to false, which
      // would flash phantom setup steps — read loading as "unknown" instead.
      return {
        driftStatsExists: r.driftLoading ? undefined : r.driftStatsExists,
        driftUserExists: r.driftLoading ? undefined : r.driftUserExists,
      };
    case 'pay-streamflow':
      // No setup gating — Streamflow create_v2 inlines the recipient ATA.
      return {};
    default: {
      const _exhaustive: never = flow;
      throw new Error(`liveAccountState: unknown flow ${_exhaustive as string}`);
    }
  }
}
