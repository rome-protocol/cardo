// useEnsureRecipientAta — idempotently create an arbitrary Solana
// recipient's ATA via HelperProgram.create_ata_for_key (precompile 0xff…09).
//
// Why this and not the raw ATA-program create (lib/ata-init.ts): the ATA
// program funds the new account's rent from the funding signer, so creating
// a *recipient's* ATA from the sender's PDA reverts Custom(1) unless that
// PDA holds SOL. `create_ata_for_key` is a precompile primitive whose rent
// is operator-fronted (reimbursed via Rome gas accounting — the user pays
// via gas), so it works without the sender holding SOL. It's also a
// precompile (always present), unlike the wrapper's `ensureRecipientAta`
// egress selector, which not all deployed wrappers carry.
//
// Idempotent: succeeds whether or not the ATA already exists.

import { useCallback, useState } from 'react';
import { useRomeWrite } from './use-rome-write';
import type { Hex } from 'viem';
import { HELPER_PRECOMPILE_ADDR } from './wrap-unwrap-fabric';

const CREATE_ATA_FOR_KEY_ABI = [
  {
    type: 'function',
    name: 'create_ata_for_key',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'wallet', type: 'bytes32' },
      { name: 'mint', type: 'bytes32' },
    ],
    outputs: [],
  },
] as const;

export type EnsureRecipientAtaPhase =
  | 'idle'
  | 'signing'
  | 'confirming'
  | 'success'
  | 'failed';

export type EnsureRecipientAtaState = {
  phase: EnsureRecipientAtaPhase;
  hash?: `0x${string}`;
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
        return { status: json.result.status === '0x1' ? 'success' : 'reverted' };
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[cardo ensure-recipient-ata] receipt poll error', e);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`receipt poll timed out for ${hash}`);
}

export function useEnsureRecipientAta() {
  const [state, setState] = useState<EnsureRecipientAtaState>({ phase: 'idle' });
  const { writeContractAsync } = useRomeWrite();

  const ensure = useCallback(
    async (opts: {
      recipientWalletHex: Hex;
      mintHex: Hex;
    }): Promise<'success' | 'failed'> => {
      setState({ phase: 'signing' });
      try {
        const hash = await writeContractAsync({
          address: HELPER_PRECOMPILE_ADDR,
          abi: CREATE_ATA_FOR_KEY_ABI,
          functionName: 'create_ata_for_key',
          args: [opts.recipientWalletHex, opts.mintHex],
        });
        setState({ phase: 'confirming', hash });
        const r = await waitForReceipt(hash);
        if (r.status === 'reverted') {
          setState({ phase: 'failed', hash, error: 'create_ata_for_key reverted' });
          return 'failed';
        }
        setState({ phase: 'success', hash });
        return 'success';
      } catch (e) {
        setState({ phase: 'failed', error: (e as Error).message ?? String(e) });
        return 'failed';
      }
    },
    [writeContractAsync],
  );

  const reset = useCallback(() => setState({ phase: 'idle' }), []);
  return { state, ensure, reset };
}
