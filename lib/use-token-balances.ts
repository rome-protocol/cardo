// useTokenBalances — live wagmi read of ERC20 `balanceOf(address)` for
// each discovered Rome token on the connected wallet.
//
// **Why N individual hooks instead of useReadContracts:** Rome does
// not have Multicall3 deployed. wagmi's `useReadContracts` falls back
// to Multicall3 internally; on Rome the multicall call reverts with
// "multicallAddress is required" and every contract entry returns
// `status: 'failure'` with no data. Using N individual `useReadContract`
// hooks bypasses multicall entirely — each read is a plain `eth_call`
// the Rome proxy serves cleanly.
//
// Today there are at most ~4 tokens on Rome so the per-mount cost of
// 4 hooks is negligible. If the list grows past ~8 we'd need to either
// (a) re-architect via a backend-aggregated read, or (b) deploy
// Multicall3 on Rome and re-enable wagmi's batched path.
//
// Refetches every 15s so a user who just received a bridge transfer
// sees the updated balance without a hard reload.

import { useReadContract } from 'wagmi';
import { erc20Abi, type Address } from 'viem';
import { useActiveChainId } from '@/lib/env-context';

export type TokenBalances = Record<string, bigint>;
export type TokenBalancesDebug = {
  isLoading: boolean;
  isError: boolean;
  errorMsg?: string;
  rawStatuses: Array<'success' | 'failure' | 'pending' | 'unknown'>;
};

// Per-wrapper registration state derived from the balanceOf read:
//   'registered'   — read returned a value; the wrapper has bound this user's ATA
//   'unregistered' — read reverted with "Token account does not exist"; wrapper
//                    has not bound this user's ATA. Action: call factory.create_user
//                    (if this is the user's first wrapper) then wrapper.ensure_token_account.
//   'unknown'      — pending, RPC error, or unrelated revert
export type WrapperRegistrationState =
  | 'registered'
  | 'unregistered'
  | 'unknown';
export type WrapperRegistrationMap = Record<string, WrapperRegistrationState>;

// Per-token reader — one wagmi `useReadContract` per address.
function useOneBalance(token: Address, user: Address | undefined): {
  data: bigint | undefined;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
} {
  const chainId = useActiveChainId();
  const r = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: user ? [user] : undefined,
    chainId,
    query: { enabled: !!user, refetchInterval: 15_000 },
  });
  return {
    data: r.data as bigint | undefined,
    isLoading: r.isLoading,
    isError: r.isError,
    error: (r.error as Error | null) ?? null,
  };
}

/**
 * Fixed-arity balance reader. We call one hook per slot (max 8 today)
 * so React's hook ordering stays stable across re-renders even when
 * the token list grows or shrinks. Slots beyond the actual token list
 * are disabled (no user → query skipped).
 */
const MAX_SLOTS = 8;

export function useTokenBalances(
  tokenAddresses: readonly Address[],
  userAddress: Address | undefined,
): {
  balances: TokenBalances;
  registration: WrapperRegistrationMap;
  debug: TokenBalancesDebug;
} {
  // Pad to MAX_SLOTS so the hook count is fixed across renders.
  const padded: (Address | undefined)[] = Array.from({ length: MAX_SLOTS }).map(
    (_, i) => tokenAddresses[i],
  );

  /* eslint-disable react-hooks/rules-of-hooks */
  const r0 = useOneBalance((padded[0] ?? '0x0000000000000000000000000000000000000000') as Address, padded[0] ? userAddress : undefined);
  const r1 = useOneBalance((padded[1] ?? '0x0000000000000000000000000000000000000000') as Address, padded[1] ? userAddress : undefined);
  const r2 = useOneBalance((padded[2] ?? '0x0000000000000000000000000000000000000000') as Address, padded[2] ? userAddress : undefined);
  const r3 = useOneBalance((padded[3] ?? '0x0000000000000000000000000000000000000000') as Address, padded[3] ? userAddress : undefined);
  const r4 = useOneBalance((padded[4] ?? '0x0000000000000000000000000000000000000000') as Address, padded[4] ? userAddress : undefined);
  const r5 = useOneBalance((padded[5] ?? '0x0000000000000000000000000000000000000000') as Address, padded[5] ? userAddress : undefined);
  const r6 = useOneBalance((padded[6] ?? '0x0000000000000000000000000000000000000000') as Address, padded[6] ? userAddress : undefined);
  const r7 = useOneBalance((padded[7] ?? '0x0000000000000000000000000000000000000000') as Address, padded[7] ? userAddress : undefined);
  /* eslint-enable react-hooks/rules-of-hooks */
  const slots = [r0, r1, r2, r3, r4, r5, r6, r7];

  const out: TokenBalances = {};
  const registration: WrapperRegistrationMap = {};
  const rawStatuses: TokenBalancesDebug['rawStatuses'] = [];
  let anyLoading = false;
  let anyError = false;
  let firstErrorMsg: string | undefined;

  tokenAddresses.forEach((addr, i) => {
    const r = slots[i];
    if (!r) return;
    const key = addr.toLowerCase();
    if (r.isLoading) {
      rawStatuses.push('pending');
      registration[key] = 'unknown';
      anyLoading = true;
      return;
    }
    if (r.isError) {
      rawStatuses.push('failure');
      anyError = true;
      const msg = String(r.error?.message ?? r.error);
      if (!firstErrorMsg) firstErrorMsg = msg.slice(0, 80);
      // Wrapper's `get_token_account` reverts with this exact string when
      // it has no record of the user. That's the unregistered case we
      // surface a setup button for.
      registration[key] = msg.includes('Token account does not exist')
        ? 'unregistered'
        : 'unknown';
      return;
    }
    if (r.data !== undefined) {
      out[key] = r.data;
      registration[key] = 'registered';
      rawStatuses.push('success');
    } else {
      rawStatuses.push('unknown');
      registration[key] = 'unknown';
    }
  });

  return {
    balances: out,
    registration,
    debug: {
      isLoading: anyLoading,
      isError: anyError,
      errorMsg: firstErrorMsg,
      rawStatuses,
    },
  };
}
