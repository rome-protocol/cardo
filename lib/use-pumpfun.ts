// usePumpFunSwap — submit a Pump.fun bonding-curve buy or sell via
// Rome's CPI precompile. Single ix per submission, signed as the
// user's PDA. Same shape as use-pumpswap-swap / use-orca-swap.

import { useCallback, useState } from 'react';
import { useRomeWrite } from './use-rome-write';
import type { Address, Hex } from 'viem';
import { CPI_INVOKE_ABI, CPI_PRECOMPILE } from './cpi-precompile';
import {
  buildPumpFunBuyInvoke,
  buildPumpFunSellInvoke,
} from './pumpfun-instructions';
import type { BondingCurve } from './pumpfun-curves';

export type PumpFunPhase =
  | 'idle'
  | 'signing'
  | 'confirming'
  | 'success'
  | 'failed';

export type PumpFunState = {
  phase: PumpFunPhase;
  side?: 'buy' | 'sell';
  hash?: `0x${string}`;
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
      console.warn('[cardo pumpfun] receipt poll error', e);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`receipt poll timed out for ${hash}`);
}

type SwapArgs =
  | {
      side: 'buy';
      userEvmAddress: Address;
      mintHex: Hex;
      curve: BondingCurve;
      amount: bigint;
      maxSolCost: bigint;
      trackVolume?: boolean;
    }
  | {
      side: 'sell';
      userEvmAddress: Address;
      mintHex: Hex;
      curve: BondingCurve;
      amount: bigint;
      minSolOutput: bigint;
    };

export function usePumpFunSwap() {
  const [state, setState] = useState<PumpFunState>({ phase: 'idle' });
  const { writeContractAsync } = useRomeWrite();

  const swap = useCallback(
    async (args: SwapArgs) => {
      setState({ phase: 'idle', side: args.side });
      try {
        const built =
          args.side === 'buy'
            ? buildPumpFunBuyInvoke(args)
            : buildPumpFunSellInvoke(args);
        setState({ phase: 'signing', side: args.side });
        const hash = await writeContractAsync({
          address: CPI_PRECOMPILE,
          abi: CPI_INVOKE_ABI,
          functionName: 'invoke',
          args: [built.program, built.accounts, built.data],
        });
        setState({ phase: 'confirming', side: args.side, hash });
        const r = await waitForReceipt(hash);
        if (r.status === 'reverted') {
          setState({
            phase: 'failed',
            side: args.side,
            hash,
            error:
              "Pump.fun " +
              args.side +
              " reverted. Common causes: bonding curve already graduated (`complete=true` — use PumpSwap), insufficient PDA SOL balance, slippage guard tripped, or memecoin mint mismatch.",
          });
          return;
        }
        setState({ phase: 'success', side: args.side, hash });
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        setState((prev) => ({ ...prev, phase: 'failed', error: msg }));
      }
    },
    [writeContractAsync],
  );

  const reset = useCallback(() => setState({ phase: 'idle' }), []);
  return { state, swap, reset } as const;
}
