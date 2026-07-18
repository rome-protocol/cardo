// useKaminoSetup — orchestrate the two-tx Kamino account-setup flow:
//   1. init_user_metadata (one-time per user, market-independent)
//   2. init_obligation (one-time per (user, market))
//
// Both txs go through the CPI precompile via direct-precompile path
// (msg.sender == userEoa, Rome auto-signs as user PDA). Mirrors the
// pattern in lib/use-deploy-token.ts (multi-step orchestration with
// per-step phase machine + manual receipt poll).
//
// Setup is required before deposit/withdraw/borrow/repay. The page
// pre-flights both with the corresponding existence hooks (will land
// in a follow-up); when either is missing, surface the "Open lending
// account" button that calls into this hook.
//
// Per the integration playbook §4.10: receipt poll is manual against
// /api/rpc/rome because wagmi's useWaitForTransactionReceipt stalls
// on Rome.

import { useCallback, useState } from 'react';
import { useRomeWrite } from './use-rome-write';
import type { Address, Hex } from 'viem';
import { CPI_PRECOMPILE, CPI_INVOKE_ABI } from './cpi-precompile';
import {
  buildInitUserMetadataInvoke,
  buildInitObligationInvoke,
} from './kamino-instructions';

export type KaminoSetupPhase =
  | 'idle'
  | 'init-user-metadata-signing'
  | 'init-user-metadata-confirming'
  | 'init-obligation-signing'
  | 'init-obligation-confirming'
  | 'success'
  | 'failed';

export type KaminoSetupState = {
  phase: KaminoSetupPhase;
  /// Lending market we're setting up against (lowercased hex).
  marketHex?: string;
  hashes: {
    initUserMetadata?: `0x${string}`;
    initObligation?: `0x${string}`;
  };
  addresses?: {
    userMetadata?: Hex;
    obligation?: Hex;
  };
  error?: string;
};

const POLL_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 2_000;

async function waitForReceipt(hash: `0x${string}`) {
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    try {
      const res = await fetch('/api/rpc/rome', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_getTransactionReceipt',
          params: [hash],
        }),
      });
      const json = await res.json();
      if (json.result?.blockNumber) {
        return {
          status: json.result.status === '0x1' ? 'success' : 'reverted',
          transactionHash: json.result.transactionHash,
        };
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[cardo kamino-setup] receipt poll error', e);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`receipt poll timed out for ${hash}`);
}

export function useKaminoSetup() {
  const [state, setState] = useState<KaminoSetupState>({
    phase: 'idle',
    hashes: {},
  });
  const { writeContractAsync } = useRomeWrite();

  const setup = useCallback(
    async (opts: {
      userEvmAddress: Address;
      lendingMarket: Hex;
      /// When true, skip init_user_metadata (the user already has one
      /// from a previous market). Caller passes from
      /// useKaminoUserMetadataExists.
      skipUserMetadata?: boolean;
    }) => {
      const marketHex = opts.lendingMarket.toLowerCase();
      const update = (patch: Partial<KaminoSetupState>) =>
        setState((prev) => ({
          ...prev,
          ...patch,
          hashes: { ...prev.hashes, ...(patch.hashes ?? {}) },
          addresses: { ...prev.addresses, ...(patch.addresses ?? {}) },
        }));

      try {
        update({ phase: 'idle', marketHex, error: undefined });

        // Step 1: init_user_metadata (skipped when caller knows it exists)
        if (!opts.skipUserMetadata) {
          const ix1 = buildInitUserMetadataInvoke({
            userEvmAddress: opts.userEvmAddress,
          });
          update({
            phase: 'init-user-metadata-signing',
            addresses: { userMetadata: ix1.addresses.userMetadata },
          });
          const h1 = await writeContractAsync({
            address: CPI_PRECOMPILE,
            abi: CPI_INVOKE_ABI,
            functionName: 'invoke',
            args: [ix1.program, ix1.accounts, ix1.data],
          });
          update({
            phase: 'init-user-metadata-confirming',
            hashes: { initUserMetadata: h1 },
          });
          const r1 = await waitForReceipt(h1);
          if (r1.status === 'reverted') {
            throw new Error('init_user_metadata reverted on-chain');
          }
        }

        // Step 2: init_obligation
        const ix2 = buildInitObligationInvoke({
          userEvmAddress: opts.userEvmAddress,
          lendingMarket: opts.lendingMarket,
        });
        update({
          phase: 'init-obligation-signing',
          addresses: {
            userMetadata: ix2.addresses.userMetadata,
            obligation: ix2.addresses.obligation,
          },
        });
        const h2 = await writeContractAsync({
          address: CPI_PRECOMPILE,
          abi: CPI_INVOKE_ABI,
          functionName: 'invoke',
          args: [ix2.program, ix2.accounts, ix2.data],
        });
        update({
          phase: 'init-obligation-confirming',
          hashes: { initObligation: h2 },
        });
        const r2 = await waitForReceipt(h2);
        if (r2.status === 'reverted') {
          throw new Error('init_obligation reverted on-chain');
        }

        update({ phase: 'success' });
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        setState((prev) => ({
          ...prev,
          phase: 'failed',
          error: msg,
        }));
      }
    },
    [writeContractAsync],
  );

  const reset = useCallback(
    () => setState({ phase: 'idle', hashes: {} }),
    [],
  );

  return { state, setup, reset };
}
