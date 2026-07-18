// Pure signature-plan derivation — the data model behind the SignatureLedger.
//
// Given a flow + the user's on-chain account state, return the ORDERED list of
// signatures the wallet will actually sign: one-time setup steps (ATA /
// obligation / user-account init) followed by the core atomic action. The
// count is steps.length — so the UI shows the TRUE number of MetaMask
// signatures before the user commits, not a guess.
//
// Every step is its own atomic Rome CPI tx (the Solana action + the Rome
// balance change land together, or neither). A flow can still be MULTIPLE
// signatures — Rome's 1232-byte / 1.4M-CU caps mean first-time setup can't be
// folded into the action. Counts are grounded in the live flow hooks
// (see the 2026-06-26 grounding pass): swap warm 1 / fresh 2, Kamino fresh 3,
// Drift fresh 3, Streamflow always 1, etc.
//
// `accountState` flags come from the existing existence probes:
//   useAtaExists, useKaminoUserMetadataExists (+ obligation), useDriftSpotInitState.
// An UNKNOWN flag (undefined) is treated as "already set up" — the optimistic
// case — so the ledger never invents a setup step it isn't sure about; the
// live probe flips it to `false` when the account is genuinely missing.

export type FlowKind =
  | 'swap'
  | 'lend-kamino'
  | 'lend-drift'
  | 'stake'
  | 'pay-streamflow'
  | 'send';

export type AccountState = {
  /** swap / stake: the receive-token ATA owned by the user's Rome PDA. */
  outAtaExists?: boolean;
  /** send: the recipient's ATA. */
  recipientAtaExists?: boolean;
  /** Kamino: per-user UserMetadata account. */
  kaminoMetadataExists?: boolean;
  /** Kamino: per-market obligation account. */
  kaminoObligationExists?: boolean;
  /** Drift: per-authority UserStats. */
  driftStatsExists?: boolean;
  /** Drift: per-subaccount User. */
  driftUserExists?: boolean;
};

export type SigStep = {
  id: string;
  /** Plain-language, end-user-facing label for this signature. */
  label: string;
  /** Short technical detail (the Solana instruction it maps to). */
  detail?: string;
  /** Each Rome CPI tx is atomic. */
  atomic: boolean;
  /** True = one-time account setup; false = the core action. */
  setup: boolean;
};

/** A step is needed only when its account is KNOWN to be missing. */
function missing(flag: boolean | undefined): boolean {
  return flag === false;
}

export function signaturePlan(flow: FlowKind, st: AccountState = {}): SigStep[] {
  const steps: SigStep[] = [];
  switch (flow) {
    case 'swap':
      if (missing(st.outAtaExists))
        steps.push({ id: 'out-ata', label: 'Create your receiving account', detail: 'create_ata', atomic: true, setup: true });
      steps.push({ id: 'swap', label: 'Swap on Meteora', detail: 'CPI → Meteora swap', atomic: true, setup: false });
      break;
    case 'stake':
      if (missing(st.outAtaExists))
        steps.push({ id: 'stake-ata', label: 'Create your stake-token account', detail: 'create_ata', atomic: true, setup: true });
      steps.push({ id: 'stake', label: 'Stake to the pool', detail: 'deposit_sol', atomic: true, setup: false });
      break;
    case 'lend-kamino':
      if (missing(st.kaminoMetadataExists))
        steps.push({ id: 'k-meta', label: 'Create your lending account', detail: 'init_user_metadata', atomic: true, setup: true });
      if (missing(st.kaminoObligationExists))
        steps.push({ id: 'k-obl', label: 'Open your obligation', detail: 'init_obligation', atomic: true, setup: true });
      steps.push({ id: 'k-supply', label: 'Supply to Kamino', detail: 'refresh + deposit', atomic: true, setup: false });
      break;
    case 'lend-drift':
      if (missing(st.driftStatsExists))
        steps.push({ id: 'd-stats', label: 'Create your Drift stats', detail: 'initializeUserStats', atomic: true, setup: true });
      if (missing(st.driftUserExists))
        steps.push({ id: 'd-user', label: 'Create your Drift account', detail: 'initializeUser', atomic: true, setup: true });
      steps.push({ id: 'd-deposit', label: 'Deposit to Drift', detail: 'deposit', atomic: true, setup: false });
      break;
    case 'pay-streamflow':
      // Streamflow create_v2 creates the recipient ATA inline (init_if_needed)
      // and signs as the user's Rome PDA — no ephemeral keypair — so it's
      // genuinely a single signature regardless of recipient state.
      steps.push({ id: 'stream', label: 'Open the stream', detail: 'create_v2 · recipient account inline', atomic: true, setup: false });
      break;
    case 'send':
      if (missing(st.recipientAtaExists))
        steps.push({ id: 'recip-ata', label: "Create the recipient's account", detail: 'create_ata', atomic: true, setup: true });
      steps.push({ id: 'send', label: 'Send', detail: 'transfer_spl', atomic: true, setup: false });
      break;
    default: {
      const _exhaustive: never = flow;
      throw new Error(`signaturePlan: unknown flow ${_exhaustive as string}`);
    }
  }
  return steps;
}

/** Convenience: the true number of MetaMask signatures for this flow + state. */
export function signatureCount(flow: FlowKind, st?: AccountState): number {
  return signaturePlan(flow, st).length;
}
