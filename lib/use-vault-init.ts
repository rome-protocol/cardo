// useVaultInit — submit a Meteora dynamic-vault initialize tx via
// Rome's CPI precompile, using the connected EVM wallet. Replaces the
// "ping the Rome team to spin one up" copy on /pool/new — users can
// bootstrap a vault for any SPL mint they hold without leaving Cardo.
//
// Mirrors the receipt-poll pattern used by useRegisterWrapper and the
// /swap submit path: wagmi's `useWaitForTransactionReceipt` is flaky
// on Rome, so we hit /api/rpc/rome directly every 2s.

import { useCallback, useState } from 'react';
import { useRomeWrite } from './use-rome-write';
import type { Address, Hex } from 'viem';
import { CPI_PRECOMPILE, CPI_INVOKE_ABI } from './cpi-precompile';
import { buildChainMeteoraVaultInitInvoke } from './meteora-vault-init';

export type VaultInitPhase = 'idle' | 'signing' | 'confirming' | 'success' | 'failed';

export type VaultInitState = {
  phase: VaultInitPhase;
  /// Mint we're initializing the vault for (lowercased hex). Set as
  /// soon as `initVault` is called so the screen can render per-row
  /// progress.
  mintHex?: string;
  hash?: `0x${string}`;
  vaultAddress?: string;
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
      // eslint-disable-next-line no-console
      console.warn('[cardo vault-init] receipt poll error', e);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`receipt poll timed out for ${hash}`);
}

export function useVaultInit() {
  const [state, setState] = useState<VaultInitState>({ phase: 'idle' });
  const { writeContractAsync } = useRomeWrite();

  const initVault = useCallback(
    async (opts: { userEvmAddress: Address; mintHex: Hex }) => {
      const mintHexLc = opts.mintHex.toLowerCase();
      setState({ phase: 'idle', mintHex: mintHexLc });
      try {
        const { program, accounts, data, addresses } =
          buildChainMeteoraVaultInitInvoke(opts);

        setState({ phase: 'signing', mintHex: mintHexLc });
        const hash = await writeContractAsync({
          address: CPI_PRECOMPILE,
          abi: CPI_INVOKE_ABI,
          functionName: 'invoke',
          args: [program, accounts, data],
        });
        setState({
          phase: 'confirming',
          mintHex: mintHexLc,
          hash,
          vaultAddress: addresses.vault.toBase58(),
        });

        const r = await waitForReceipt(hash);
        if (r.status === 'reverted') {
          setState({
            phase: 'failed',
            mintHex: mintHexLc,
            hash,
            vaultAddress: addresses.vault.toBase58(),
            error: 'vault.initialize reverted on-chain',
          });
          return;
        }
        setState({
          phase: 'success',
          mintHex: mintHexLc,
          hash,
          vaultAddress: addresses.vault.toBase58(),
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

  return { state, initVault, reset };
}
