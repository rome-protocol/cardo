// useWrapGasToSpl / useUnwrapSplToGas — wagmi hooks that drive the native-gas ↔
// chain-mint-id SPL conversion (idle → signing → confirming → success/failed).
//
// WRAP   = native gas → chain-mint SPL ATA  → Withdraw.withdraw_to_ata   (0x42..16)
// UNWRAP = chain-mint SPL ATA → native gas  → HelperProgram.deposit_from_ata (0xff..09)
//
// Fees: estimated on-chain + a safety factor via romeFeeOverrides — no hardcoded
// gas. Rome's baseFee=0 makes MetaMask's own estimate fail, so we set explicit
// fee fields ourselves. (Mirrors the Rome web app's live useWrapUnwrap.ts.)
//
// SCOPE (mirrors wrap-unwrap-fabric.ts): only valid for the chain's gas-backing
// mint (wUSDC on Rome). Do not use for wSOL/wETH wrappers — those ARE the ATA.

import { useCallback, useState } from 'react';
import { useSendTransaction, useAccount, usePublicClient } from 'wagmi';
import type { Hex } from 'viem';
import { useActiveChainId } from './env-context';
import {
  encodeWrapCall,
  encodeUnwrapCall,
  WITHDRAW_PRECOMPILE_ADDR,
  HELPER_PRECOMPILE_ADDR,
} from './wrap-unwrap-fabric';
import { romeFeeOverrides } from './rome-fee';

export type WrapPhase = 'idle' | 'signing' | 'confirming' | 'success' | 'failed';

export type WrapState = {
  phase: WrapPhase;
  /// 'wrap' = native gas → SPL ATA; 'unwrap' = SPL ATA → native gas.
  side?: 'wrap' | 'unwrap';
  hash?: Hex;
  error?: string;
};

const POLL_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 2_000;

async function waitForReceipt(hash: Hex): Promise<{ status: 'success' | 'reverted' }> {
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
      console.warn('[cardo wrap] receipt poll error', e);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`receipt poll timed out for ${hash}`);
}

/// Shared wrap/unwrap state machine — encodes the precompile call, estimates the
/// fee on-chain (+factor), sends, and polls the receipt.
function useConvertHook(
  side: 'wrap' | 'unwrap',
  precompile: `0x${string}`,
  encode: (amountWei: bigint) => Hex,
) {
  const [state, setState] = useState<WrapState>({ phase: 'idle' });
  const { sendTransactionAsync } = useSendTransaction();
  const { address } = useAccount();
  const chainId = useActiveChainId();
  const pub = usePublicClient({ chainId });

  const run = useCallback(
    async (amountWei: bigint) => {
      setState({ phase: 'idle', side });
      try {
        if (amountWei <= 0n) throw new Error('amount must be > 0');
        if (!address) throw new Error('connect a wallet first');
        const data = encode(amountWei);
        const fee = await romeFeeOverrides(pub, { account: address, to: precompile, data });
        setState({ phase: 'signing', side });
        const hash = await sendTransactionAsync({ to: precompile, data, ...fee });
        setState({ phase: 'confirming', side, hash });
        const r = await waitForReceipt(hash);
        if (r.status === 'reverted') {
          setState({
            phase: 'failed',
            side,
            hash,
            error: `${side} reverted. Common causes: insufficient ${side === 'wrap' ? 'native gas' : 'SPL balance'}, or no chain_mint_id configured.`,
          });
          return;
        }
        setState({ phase: 'success', side, hash });
      } catch (e) {
        setState((prev) => ({ ...prev, phase: 'failed', error: (e as Error).message ?? String(e) }));
      }
    },
    [sendTransactionAsync, address, pub],
  );

  const reset = useCallback(() => setState({ phase: 'idle' }), []);
  return { state, run, reset } as const;
}

/// WRAP leg `withdraw_to_ata(amount)`. `amountWei` is rsol-wei (18 decimals) —
/// use `uiAmountToWei` from wrap-unwrap-fabric.ts to convert UI input.
export function useWrapGasToSpl() {
  const { state, run, reset } = useConvertHook('wrap', WITHDRAW_PRECOMPILE_ADDR as `0x${string}`, encodeWrapCall);
  return { state, wrap: run, reset } as const;
}

/// UNWRAP leg `deposit_from_ata(amount)`.
export function useUnwrapSplToGas() {
  const { state, run, reset } = useConvertHook('unwrap', HELPER_PRECOMPILE_ADDR as `0x${string}`, encodeUnwrapCall);
  return { state, unwrap: run, reset } as const;
}
