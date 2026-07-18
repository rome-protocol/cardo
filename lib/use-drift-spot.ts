// useDriftSpotInit / useDriftSpotDeposit / useDriftSpotWithdraw —
// wagmi hooks for the Drift v2 Spot lifecycle:
//
//   1. initializeUserStats   (one-time per authority)
//   2. initializeUser        (one-time per authority+subAccountId)
//   3. deposit / withdraw    (per-action)
//
// Steps 1 + 2 are idempotent on Drift's side but the program reverts if
// you call them twice — so the page wrapper detects existing PDAs via
// `useDriftSpotInitState` and skips them when set.
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md

import { useCallback, useEffect, useState } from 'react';
import { useRomeWrite } from './use-rome-write';
import type { Address, Hex } from 'viem';
import { CPI_INVOKE_ABI, CPI_PRECOMPILE } from './cpi-precompile';
import {
  buildDepositInvoke,
  buildDriftSpotWithdrawInvoke,
  buildInitializeUserInvoke,
  buildInitializeUserStatsInvoke,
} from './drift-spot-instructions';
import {
  bytes32ToPublicKey,
  deriveRomeUserPda,
} from './solana-pda';
import {
  deriveDriftUser,
  deriveDriftUserStats,
} from './drift-pdas';

// ─────────────────────────────────────────────────────────────────────
// Phase + state machine shared across hooks
// ─────────────────────────────────────────────────────────────────────

export type DriftPhase =
  | 'idle'
  | 'signing'
  | 'confirming'
  | 'success'
  | 'failed';

export type DriftState = {
  phase: DriftPhase;
  side?: 'init-stats' | 'init-user' | 'deposit' | 'withdraw';
  hash?: Hex;
  error?: string;
};

const POLL_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 2_000;

async function waitForReceipt(
  hash: Hex,
): Promise<{ status: 'success' | 'reverted' }> {
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
        };
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[cardo drift-spot] receipt poll error', e);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`receipt poll timed out for ${hash}`);
}

function makeHook<TArgs>(
  side: DriftState['side'],
  build: (args: TArgs) => {
    program: Hex;
    accounts: { pubkey: Hex; is_signer: boolean; is_writable: boolean }[];
    data: Hex;
  },
) {
  return function useHook() {
    const [state, setState] = useState<DriftState>({ phase: 'idle' });
    const { writeContractAsync } = useRomeWrite();

    const run = useCallback(
      async (args: TArgs) => {
        setState({ phase: 'idle', side });
        try {
          const built = build(args);
          setState({ phase: 'signing', side });
          const hash = await writeContractAsync({
            address: CPI_PRECOMPILE,
            abi: CPI_INVOKE_ABI,
            functionName: 'invoke',
            args: [built.program, built.accounts, built.data],
          });
          setState({ phase: 'confirming', side, hash });
          const r = await waitForReceipt(hash);
          if (r.status === 'reverted') {
            setState({
              phase: 'failed',
              side,
              hash,
              error:
                'Drift Spot ' +
                side +
                ' reverted. Common causes: stale oracle, init step already ran (rerun is forbidden), insufficient ATA balance, or remaining-accounts mismatch.',
            });
            return;
          }
          setState({ phase: 'success', side, hash });
        } catch (e) {
          setState((prev) => ({
            ...prev,
            phase: 'failed',
            error: (e as Error).message ?? String(e),
          }));
        }
      },
      [writeContractAsync],
    );

    const reset = useCallback(() => setState({ phase: 'idle' }), []);
    return { state, run, reset } as const;
  };
}

// Concrete hooks.

type InitStatsArgs = Parameters<typeof buildInitializeUserStatsInvoke>[0];
type InitUserArgs = Parameters<typeof buildInitializeUserInvoke>[0];
type DepositArgs = Parameters<typeof buildDepositInvoke>[0];
type WithdrawArgs = Parameters<typeof buildDriftSpotWithdrawInvoke>[0];

const _useInitStats = makeHook<InitStatsArgs>(
  'init-stats',
  buildInitializeUserStatsInvoke,
);
const _useInitUser = makeHook<InitUserArgs>(
  'init-user',
  buildInitializeUserInvoke,
);
const _useDeposit = makeHook<DepositArgs>(
  'deposit',
  buildDepositInvoke,
);
const _useWithdraw = makeHook<WithdrawArgs>(
  'withdraw',
  buildDriftSpotWithdrawInvoke,
);

export function useDriftInitStats() {
  const { state, run, reset } = _useInitStats();
  return { state, init: run, reset } as const;
}
export function useDriftInitUser() {
  const { state, run, reset } = _useInitUser();
  return { state, init: run, reset } as const;
}
export function useDriftDeposit() {
  const { state, run, reset } = _useDeposit();
  return { state, deposit: run, reset } as const;
}
export function useDriftWithdraw() {
  const { state, run, reset } = _useWithdraw();
  return { state, withdraw: run, reset } as const;
}

// ─────────────────────────────────────────────────────────────────────
// useDriftSpotInitState — read-only check for "did the user already
// run initializeUserStats / initializeUser?". Drives the page's
// step-skipping UI.
//
// Hits /api/rpc/solana-devnet for two getAccountInfo calls (via
// getMultipleAccounts) and returns three flags + the derived PDAs.
// Re-fetches on a poll interval so the UI flips to the next step
// shortly after a successful init tx confirms on Solana.
// ─────────────────────────────────────────────────────────────────────

export type DriftInitFlags = {
  loading: boolean;
  userStatsExists: boolean;
  userExists: boolean;
  userPda?: Hex;
  userStatsPda?: Hex;
};

const RPC = '/api/rpc/solana-devnet';
const POLL_MS = 8_000;

export function useDriftSpotInitState(
  userEvmAddress: Address | undefined,
  subAccountId = 0,
): DriftInitFlags {
  const [flags, setFlags] = useState<DriftInitFlags>({
    loading: true,
    userStatsExists: false,
    userExists: false,
  });

  useEffect(() => {
    if (!userEvmAddress) {
      setFlags({ loading: false, userStatsExists: false, userExists: false });
      return;
    }
    let cancelled = false;
    let authority: Hex;
    let userPda: Hex;
    let userStatsPda: Hex;
    try {
      authority = deriveRomeUserPda(userEvmAddress);
      userPda = deriveDriftUser({ authority, subAccountId });
      userStatsPda = deriveDriftUserStats(authority);
    } catch {
      setFlags({ loading: false, userStatsExists: false, userExists: false });
      return;
    }
    const userBs58 = bytes32ToPublicKey(userPda).toBase58();
    const statsBs58 = bytes32ToPublicKey(userStatsPda).toBase58();

    // Race fix: when the wallet connects (or mintBs58 changes), reset
    // to loading=true and clear stale flags so the screen never renders
    // an init-step button on stale "doesn't exist" data. The very first
    // tick below replaces these with the live values.
    setFlags({
      loading: true,
      userStatsExists: false,
      userExists: false,
      userPda,
      userStatsPda,
    });

    const tick = async () => {
      try {
        const res = await fetch(RPC, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getMultipleAccounts',
            params: [[userBs58, statsBs58], { encoding: 'base64' }],
          }),
        });
        const json = await res.json();
        if (cancelled) return;
        const arr = json?.result?.value || [];
        setFlags({
          loading: false,
          userExists: !!arr[0],
          userStatsExists: !!arr[1],
          userPda,
          userStatsPda,
        });
      } catch {
        if (!cancelled) {
          setFlags({
            loading: false,
            userExists: false,
            userStatsExists: false,
            userPda,
            userStatsPda,
          });
        }
      }
    };
    void tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [userEvmAddress, subAccountId]);

  return flags;
}
