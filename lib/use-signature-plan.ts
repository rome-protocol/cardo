// useSignaturePlan — the live "what will happen" plan for a flow.
//
// Composes the existing existence probes (useAtaExists,
// useKaminoUserMetadataExists / Obligation, useDriftSpotInitState) into the
// ordered SigStep[] the SignatureLedger renders. The user sees the TRUE number
// of MetaMask signatures — including any one-time account setup — before they
// commit.
//
// Every probe is called unconditionally (React's rules of hooks) but fed
// flow-gated inputs: a probe outside the active flow gets `undefined` and goes
// inert (no Solana polling, status stays 'unknown'). So the swap page doesn't
// quietly poll Kamino accounts, etc.
//
// Pure decision logic lives in signature-plan-live.ts (unit-tested); this file
// is the React wiring, render-verified in the browser.

import { useCallback, useMemo } from 'react';
import type { Address, Hex } from 'viem';
import { signaturePlan, type AccountState, type FlowKind, type SigStep } from './signature-plan';
import { liveAccountState, type ProbeReadings } from './signature-plan-live';
import { useAtaExists } from './use-ata-exists';
import {
  useKaminoObligationExists,
  useKaminoUserMetadataExists,
} from './use-kamino-account-exists';
import { useDriftSpotInitState } from './use-drift-spot';

export type UseSignaturePlanArgs = {
  flow: FlowKind;
  /** The connected user. swap/stake/lend gate on its accounts; send is the sender. */
  userEvmAddress?: Address;
  /** swap / stake: the token the user RECEIVES — its ATA may need creating. */
  outMintHex?: Hex;
  /** send: the recipient and the mint being sent (recipient's ATA is checked). */
  recipient?: Address;
  sendMintHex?: Hex;
  /** lend-kamino: the market whose obligation is checked. */
  kaminoLendingMarket?: Hex;
  /** lend-drift: subaccount id (default 0). */
  driftSubAccountId?: number;
};

export type UseSignaturePlanResult = {
  /** Ordered signatures the wallet will sign: setup steps then the action. */
  steps: SigStep[];
  /** steps.length — the true MetaMask signature count. */
  count: number;
  /** How many of those are one-time account setup. */
  setupCount: number;
  /** True while the relevant probe's first read is still in flight. */
  loading: boolean;
  /** The resolved account state behind the plan (for debugging / advanced UI). */
  accountState: AccountState;
  /** Kick the relevant probes (e.g. right after a setup tx confirms). */
  refresh: () => void;
};

export function useSignaturePlan(args: UseSignaturePlanArgs): UseSignaturePlanResult {
  const {
    flow,
    userEvmAddress,
    outMintHex,
    recipient,
    sendMintHex,
    kaminoLendingMarket,
    driftSubAccountId,
  } = args;

  // Flow-gated probe inputs: the ATA probe serves swap/stake (user's receive
  // token) and send (recipient's token); inert otherwise.
  const ataInput =
    flow === 'swap' || flow === 'stake'
      ? { userEvmAddress, mintHex: outMintHex }
      : flow === 'send'
        ? { userEvmAddress: recipient, mintHex: sendMintHex }
        : { userEvmAddress: undefined, mintHex: undefined };
  const ata = useAtaExists(ataInput);

  const isKamino = flow === 'lend-kamino';
  const kMeta = useKaminoUserMetadataExists(isKamino ? userEvmAddress : undefined);
  const kObl = useKaminoObligationExists({
    userEvmAddress: isKamino ? userEvmAddress : undefined,
    lendingMarket: isKamino ? kaminoLendingMarket : undefined,
  });

  const drift = useDriftSpotInitState(
    flow === 'lend-drift' ? userEvmAddress : undefined,
    driftSubAccountId ?? 0,
  );

  // Build readings inside the memo from the primitive probe fields so the
  // dependency array is the primitives themselves — not a fresh object every
  // render (which would defeat the memo and trip exhaustive-deps).
  const { steps, count, setupCount, accountState } = useMemo(() => {
    const readings: ProbeReadings = {
      ataStatus: ata.status,
      kaminoMetaStatus: kMeta.status,
      kaminoOblStatus: kObl.status,
      driftLoading: drift.loading,
      driftStatsExists: drift.userStatsExists,
      driftUserExists: drift.userExists,
    };
    const st = liveAccountState(flow, readings);
    const s = signaturePlan(flow, st);
    return {
      steps: s,
      count: s.length,
      setupCount: s.filter((step) => step.setup).length,
      accountState: st,
    };
  }, [
    flow,
    ata.status,
    kMeta.status,
    kObl.status,
    drift.loading,
    drift.userStatsExists,
    drift.userExists,
  ]);

  // Loading = a probe we actually fired hasn't returned its first read yet.
  // Gated on the inputs being present so an unselected token / unconnected
  // wallet doesn't read as "loading forever".
  let loading = false;
  switch (flow) {
    case 'swap':
    case 'stake':
      loading = !!userEvmAddress && !!outMintHex && ata.status === 'unknown';
      break;
    case 'send':
      loading = !!recipient && !!sendMintHex && ata.status === 'unknown';
      break;
    case 'lend-kamino':
      loading =
        (!!userEvmAddress && kMeta.status === 'unknown') ||
        (!!userEvmAddress && !!kaminoLendingMarket && kObl.status === 'unknown');
      break;
    case 'lend-drift':
      loading = !!userEvmAddress && drift.loading;
      break;
    case 'pay-streamflow':
      loading = false;
      break;
  }

  const ataRefresh = ata.refresh;
  const kMetaRefresh = kMeta.refresh;
  const kOblRefresh = kObl.refresh;
  const refresh = useCallback(() => {
    ataRefresh();
    kMetaRefresh();
    kOblRefresh();
    // Drift self-polls on an interval; no manual refresh exposed.
  }, [ataRefresh, kMetaRefresh, kOblRefresh]);

  return { steps, count, setupCount, loading, accountState, refresh };
}
