// useRegisterWrapper — turn an unregistered ERC20-SPL wrapper into a
// registered one for the connected user, so MetaMask (and any standard
// ERC20 consumer) can read `balanceOf(user)` without reverting.
//
// Two on-chain steps. Both are idempotent — calling them when the user
// is already registered just re-validates state, so we don't have to
// gate strictly on detection. We do skip step 1 when we *know* the user
// is already factory-registered (any other wrapper.balanceOf returned),
// to keep the wallet popups to one in the common case.
//
//   1. ERC20SPLFactory.create_user() — registers the user in the
//      factory's shared `ERC20Users` registry. Creates their
//      payer PDA on Solana side. Required ONCE per user across all
//      wrappers from this factory.
//
//   2. SPL_ERC20.ensure_token_account(user) — binds the user's SPL
//      ATA to *this* wrapper's `_accounts` mapping, so subsequent
//      `balanceOf` calls find the ATA and don't revert.
//
// Receipt waiting routes through /api/rpc/rome directly because
// wagmi's `useWaitForTransactionReceipt` was observed to stall on
// Rome during swap-path testing — same workaround as the swap submit
// loop in app/swap/page.tsx.

import { useCallback, useState } from 'react';
import { useRomeWrite } from './use-rome-write';
import type { Address } from 'viem';
import { ROME_ADDRESSES } from '@/lib/addresses';

const FACTORY_CREATE_USER_ABI = [
  {
    name: 'create_user',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  },
] as const;

const WRAPPER_ENSURE_TOKEN_ACCOUNT_ABI = [
  {
    name: 'ensure_token_account',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ name: '', type: 'bytes32' }],
  },
] as const;

export type RegisterPhase =
  | 'idle'
  | 'creating-user'
  | 'confirming-user'
  | 'binding-account'
  | 'confirming-account'
  | 'success'
  | 'failed';

export type RegisterState = {
  phase: RegisterPhase;
  wrapperAddress?: Address;
  factoryHash?: `0x${string}`;
  wrapperHash?: `0x${string}`;
  error?: string;
};

const POLL_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 2_000;

async function waitForReceipt(
  hash: `0x${string}`,
): Promise<{ status: 'success' | 'reverted'; transactionHash: `0x${string}` }> {
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
      // Transient network error — keep polling until timeout.
      // eslint-disable-next-line no-console
      console.warn('[cardo register] receipt poll error', e);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`receipt poll timed out for ${hash}`);
}

export function useRegisterWrapper() {
  const [state, setState] = useState<RegisterState>({ phase: 'idle' });
  const { writeContractAsync } = useRomeWrite();

  const register = useCallback(
    async (opts: {
      wrapperAddress: Address;
      userAddress: Address;
      // Skip factory.create_user when caller already has evidence the
      // user is factory-registered (any other wrapper.balanceOf returned
      // a value). Saves one wallet popup in the common case.
      skipCreateUser?: boolean;
    }) => {
      setState({ phase: 'idle', wrapperAddress: opts.wrapperAddress });
      try {
        let factoryHash: `0x${string}` | undefined;

        if (!opts.skipCreateUser) {
          setState({ phase: 'creating-user', wrapperAddress: opts.wrapperAddress });
          factoryHash = await writeContractAsync({
            address: ROME_ADDRESSES.erc20SplFactoryCanonical as Address,
            abi: FACTORY_CREATE_USER_ABI,
            functionName: 'create_user',
          });
          setState({
            phase: 'confirming-user',
            wrapperAddress: opts.wrapperAddress,
            factoryHash,
          });
          const r1 = await waitForReceipt(factoryHash);
          if (r1.status === 'reverted') {
            setState({
              phase: 'failed',
              wrapperAddress: opts.wrapperAddress,
              factoryHash,
              error: 'factory.create_user reverted on-chain',
            });
            return;
          }
        }

        setState({
          phase: 'binding-account',
          wrapperAddress: opts.wrapperAddress,
          factoryHash,
        });
        const wrapperHash = await writeContractAsync({
          address: opts.wrapperAddress,
          abi: WRAPPER_ENSURE_TOKEN_ACCOUNT_ABI,
          functionName: 'ensure_token_account',
          args: [opts.userAddress],
        });
        setState({
          phase: 'confirming-account',
          wrapperAddress: opts.wrapperAddress,
          factoryHash,
          wrapperHash,
        });
        const r2 = await waitForReceipt(wrapperHash);
        if (r2.status === 'reverted') {
          setState({
            phase: 'failed',
            wrapperAddress: opts.wrapperAddress,
            factoryHash,
            wrapperHash,
            error: 'wrapper.ensure_token_account reverted on-chain',
          });
          return;
        }

        setState({
          phase: 'success',
          wrapperAddress: opts.wrapperAddress,
          factoryHash,
          wrapperHash,
        });
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

  const reset = useCallback(() => setState({ phase: 'idle' }), []);

  return { state, register, reset };
}
