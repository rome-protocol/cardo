'use client';
// useRomeWrite — a drop-in replacement for wagmi's useWriteContract that
// guarantees the wallet is on the active Rome chain BEFORE every state-changing
// transaction.
//
// WHY: Cardo's dapp flows (swap / lend / stake / pay / vote / pool / send) call
// Rome's CPI precompile, which only exists on the active Rome chain. If the
// wallet is on another chain — or desynced (MetaMask shows Rome while the
// injected provider still reports e.g. Sepolia) — a write either lands on the
// wrong chain or fails with a confusing revert, and the user only gets an
// easy-to-miss "switch network" banner. So every write auto-switches first,
// surfacing a clear, actionable error if the wallet refuses.
//
// This mirrors the proven switchChainAsync-before-send pattern the bridge hooks
// already use (lib/use-outbound-wh-send.ts), centralized so EVERY tx hook gets
// it for free: a hook that uses `useRomeWrite()` instead of `useWriteContract()`
// is automatically chain-guarded, and a future tx hook is too.

import { useCallback } from 'react';
import {
  useAccount,
  useChainId,
  usePublicClient,
  useSwitchChain,
  useWriteContract,
} from 'wagmi';
import { encodeFunctionData, type Abi, type Address, type Hex } from 'viem';
import { useActiveChainId } from './env-context';
import { romeFeeOverrides } from './rome-fee';

/// Gas-limit ceiling when estimateGas reverts for a CPI write (some Rome
/// CPIs only succeed in a real tx). Matches the blanket limit every hook
/// hardcoded before fees were centralized here.
const CPI_ESTIMATE_REVERT_FALLBACK_GAS = 30_000_000n;

/// Ensure the connected wallet is on the active Rome chain; switch if not.
/// No-op when already on-chain. Throws a clear, user-facing error if the wallet
/// rejects or fails the switch. Use directly in non-writeContract tx paths
/// (e.g. useSendTransaction-based hooks).
export function useEnsureRomeChain() {
  const walletChainId = useChainId();
  const romeChainId = useActiveChainId();
  const { switchChainAsync } = useSwitchChain();
  return useCallback(async (): Promise<void> => {
    if (walletChainId === romeChainId) return;
    try {
      // switchChainAsync (not fire-and-forget switchChain) reliably reaches
      // MetaMask and also triggers wallet_addEthereumChain via the 4902 path
      // when Rome isn't in the wallet yet.
      await switchChainAsync({ chainId: romeChainId });
    } catch (err) {
      throw new Error(
        `This action runs on Rome (chain ${romeChainId}), but your wallet is on chain ` +
          `${walletChainId}. Approve the network switch in your wallet and try again. ` +
          `(${(err as Error)?.message ?? String(err)})`,
      );
    }
  }, [walletChainId, romeChainId, switchChainAsync]);
}

/// Drop-in for wagmi's `useWriteContract`: identical return shape, except
/// `writeContract` / `writeContractAsync` auto-switch the wallet to the active
/// Rome chain first, pin `chainId` on the request, and fill in Rome fee
/// params (legacy type + gasPrice + gas) when the caller doesn't pass them.
///
/// Fee behavior: gas comes from eth_estimateGas × 1.5 (fallback 30M only when
/// the estimate itself reverts), gasPrice from eth_gasPrice. Hooks used to
/// hardcode `gas: 30_000_000n`, which made MetaMask display a ~0.33 gas-token
/// "network fee" (30M × 11 gwei) — and demand that much balance — for txs
/// that actually charge ~10-30K gas. Callers with a genuinely special gas
/// need (e.g. swap_gas_to_lamports, whose limit must exceed the lamport
/// reserve it debits) still pass `gas` explicitly and win.
export function useRomeWrite() {
  const ensureChain = useEnsureRomeChain();
  const romeChainId = useActiveChainId();
  const publicClient = usePublicClient({ chainId: romeChainId });
  const { address: connectedAddress } = useAccount();
  const wc = useWriteContract();

  type WriteAsync = typeof wc.writeContractAsync;
  type WriteSync = typeof wc.writeContract;

  const writeContractAsync = useCallback(
    (async (variables: Parameters<WriteAsync>[0], options?: Parameters<WriteAsync>[1]) => {
      await ensureChain();
      // Pin chainId so wagmi also enforces the target chain on the request
      // (defense in depth alongside the explicit switch above).
      const v: Record<string, unknown> = {
        chainId: romeChainId,
        ...(variables as Record<string, unknown>),
      };
      if (v.gas === undefined || v.gasPrice === undefined) {
        const account = (v.account ?? connectedAddress) as Address | undefined;
        let data: Hex | undefined;
        try {
          data = encodeFunctionData({
            abi: v.abi as Abi,
            functionName: v.functionName as string,
            args: v.args as readonly unknown[],
          });
        } catch {
          /* leave fees to the wallet if calldata can't be encoded here */
        }
        if (account && data) {
          const fee = await romeFeeOverrides(
            publicClient,
            { account, to: v.address as Address, data, value: v.value as bigint | undefined },
            { fallbackGas: CPI_ESTIMATE_REVERT_FALLBACK_GAS },
          );
          if (v.gasPrice === undefined) {
            v.gasPrice = fee.gasPrice;
            v.type = v.type ?? 'legacy';
          }
          if (v.gas === undefined) v.gas = fee.gas;
        }
      }
      return wc.writeContractAsync(v as Parameters<WriteAsync>[0], options as Parameters<WriteAsync>[1]);
    }) as WriteAsync,
    [ensureChain, romeChainId, publicClient, connectedAddress, wc],
  );

  // Sync variant: fire-and-forget through the same fee-filling async path;
  // outcome/error still surface via the hook's mutation state.
  const writeContract = useCallback(
    ((variables: Parameters<WriteSync>[0], options?: Parameters<WriteSync>[1]) => {
      void (writeContractAsync as unknown as (
        v: Parameters<WriteSync>[0],
        o?: Parameters<WriteSync>[1],
      ) => Promise<unknown>)(variables, options).catch(() => {
        /* surfaced via the hook's error state; swallow here so the
           fire-and-forget variant doesn't produce an unhandled rejection */
      });
    }) as WriteSync,
    [writeContractAsync],
  );

  return { ...wc, writeContract, writeContractAsync };
}
