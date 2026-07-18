// useSplTransfer — submit an SPL Token TransferChecked via Rome's CPI
// precompile. Single ix, single user signature.
//
// Mirrors Sprint 1's hooks: wagmi `writeContractAsync` → manual
// /api/rpc/rome receipt poll (per playbook §4.10).
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md
// (Family 8, Phase A — Tier A0 finisher).

import { useCallback, useState } from 'react';
import { useRomeWrite } from './use-rome-write';
import type { Address, Hex } from 'viem';
import { CPI_PRECOMPILE, CPI_INVOKE_ABI } from './cpi-precompile';
import { buildSplTransferInvoke } from './spl-transfer-instructions';

export type SplTransferPhase =
  | 'idle'
  | 'signing'
  | 'confirming'
  | 'success'
  | 'failed';

export type SplTransferState = {
  phase: SplTransferPhase;
  /// Display symbol (e.g. "WUSDC", "USDC") echoed for the in-progress UI.
  symbol?: string;
  /// Amount in mint smallest units.
  amount?: bigint;
  hash?: `0x${string}`;
  /// Resolved destination ATA (helpful for the success-state link to
  /// a Solana explorer).
  destAta?: Hex;
  error?: string;
};

const POLL_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 2_000;

async function waitForReceipt(
  hash: `0x${string}`,
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
        return { status: json.result.status === '0x1' ? 'success' : 'reverted' };
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[cardo spl-transfer] receipt poll error', e);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`receipt poll timed out for ${hash}`);
}

export function useSplTransfer() {
  const [state, setState] = useState<SplTransferState>({ phase: 'idle' });
  const { writeContractAsync } = useRomeWrite();

  const send = useCallback(
    async (opts: {
      userEvmAddress: Address;
      recipientWalletHex: Hex;
      mintHex: Hex;
      decimals: number;
      amount: bigint;
      symbol?: string;
      tokenProgramHex?: Hex;
    }) => {
      setState({ phase: 'idle', symbol: opts.symbol, amount: opts.amount });
      try {
        const { program, accounts, data, addresses } = buildSplTransferInvoke(opts);
        setState({
          phase: 'signing',
          symbol: opts.symbol,
          amount: opts.amount,
          destAta: addresses.destAta,
        });
        const hash = await writeContractAsync({
          address: CPI_PRECOMPILE,
          abi: CPI_INVOKE_ABI,
          functionName: 'invoke',
          args: [program, accounts, data],
        });
        setState({
          phase: 'confirming',
          symbol: opts.symbol,
          amount: opts.amount,
          hash,
          destAta: addresses.destAta,
        });
        const r = await waitForReceipt(hash);
        if (r.status === 'reverted') {
          setState({
            phase: 'failed',
            symbol: opts.symbol,
            amount: opts.amount,
            hash,
            destAta: addresses.destAta,
            error:
              "Transfer reverted on-chain. Most common cause: recipient doesn't have an account (ATA) for this token yet — they need to receive once on-chain or initialize it themselves.",
          });
          return;
        }
        setState({
          phase: 'success',
          symbol: opts.symbol,
          amount: opts.amount,
          hash,
          destAta: addresses.destAta,
        });
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        setState((prev) => ({ ...prev, phase: 'failed', error: msg }));
      }
    },
    [writeContractAsync],
  );

  const reset = useCallback(() => setState({ phase: 'idle' }), []);

  return { state, send, reset };
}
