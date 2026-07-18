// useAtaInit — fire create_associated_token_account_idempotent for an
// arbitrary SPL mint, owned by the user's Rome PDA, via Rome CPI.
//
// Generic. Used by /lend pre-flight rows to surface a "Set up <mint>
// account" button when the ATA is missing. Per playbook §4b.8: this
// is a visible setup button, NOT auto-fired inside any action hook.
//
// Receipt poll is the same /api/rpc/rome pattern as every other
// Cardo submit hook (playbook §4.10 — wagmi's
// useWaitForTransactionReceipt stalls on Rome).

import { useCallback, useState } from 'react';
import { useRomeWrite } from './use-rome-write';
import type { Address, Hex } from 'viem';
import { CPI_PRECOMPILE, CPI_INVOKE_ABI } from './cpi-precompile';
import { buildAtaInitInvoke } from './ata-init';

export type AtaInitPhase =
  | 'idle'
  | 'signing'
  | 'confirming'
  | 'success'
  | 'failed';

export type AtaInitState = {
  phase: AtaInitPhase;
  /// Mint we're initializing the ATA for (lowercased hex). Set as
  /// soon as `init` is called so the screen can render per-row
  /// progress when multiple ATAs are queued.
  mintHex?: string;
  hash?: `0x${string}`;
  ataAddress?: Hex;
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
      console.warn('[cardo ata-init] receipt poll error', e);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`receipt poll timed out for ${hash}`);
}

export function useAtaInit() {
  const [state, setState] = useState<AtaInitState>({ phase: 'idle' });
  const { writeContractAsync } = useRomeWrite();

  /// Returns true when the ATA landed (or already existed at submit —
  /// create is idempotent), false on revert/rejection — so callers that
  /// chain a dependent tx (e.g. /swap's cold-path swap after out-ATA
  /// create) can gate on the result instead of reading state late.
  const init = useCallback(
    async (opts: { userEvmAddress: Address; mintHex: Hex }): Promise<boolean> => {
      const mintHexLc = opts.mintHex.toLowerCase();
      setState({ phase: 'idle', mintHex: mintHexLc });
      try {
        const ix = buildAtaInitInvoke(opts);
        setState({
          phase: 'signing',
          mintHex: mintHexLc,
          ataAddress: ix.ataAddress,
        });
        const hash = await writeContractAsync({
          address: CPI_PRECOMPILE,
          abi: CPI_INVOKE_ABI,
          functionName: 'invoke',
          args: [ix.program, ix.accounts, ix.data],
        });
        setState({
          phase: 'confirming',
          mintHex: mintHexLc,
          hash,
          ataAddress: ix.ataAddress,
        });
        const r = await waitForReceipt(hash);
        if (r.status === 'reverted') {
          setState({
            phase: 'failed',
            mintHex: mintHexLc,
            hash,
            ataAddress: ix.ataAddress,
            error: 'ATA init reverted on-chain',
          });
          return false;
        }
        setState({
          phase: 'success',
          mintHex: mintHexLc,
          hash,
          ataAddress: ix.ataAddress,
        });
        return true;
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        setState((prev) => ({ ...prev, phase: 'failed', error: msg }));
        return false;
      }
    },
    [writeContractAsync],
  );

  const reset = useCallback(() => setState({ phase: 'idle' }), []);

  return { state, init, reset };
}
