// useStakePoolDepositSolWithSlippage / useStakePoolWithdrawSolWithSlippage
// — same pattern as use-stake-pool-deposit / use-stake-pool-withdraw,
// but submits the *WithSlippage variants for on-chain min-output guards.
//
// ⚠ NOT USABLE ON SOLANA DEVNET: the devnet spl-stake-pool deployment
// (SPoo1Ku8…, last deployed slot 197328814) predates the slippage
// variants — tags 24/25 fail at instruction dispatch with BorshIoError
// (verified by live simulation 2026-07-07; see
// tests/cases/stake-pool.ts canaries). /stake uses the plain
// DepositSol/WithdrawSol hooks. Keep these for chains whose stake-pool
// program is current (mainnet).

import { useCallback, useState } from 'react';
import { useRomeWrite } from './use-rome-write';
import type { Address, Hex } from 'viem';
import { CPI_INVOKE_ABI, CPI_PRECOMPILE } from './cpi-precompile';
import {
  buildDepositSolWithSlippageInvoke,
  buildWithdrawSolWithSlippageInvoke,
} from './stake-pool-instructions';
import type { StakePoolRegistryEntry } from './stake-pool-registry';

export type StakePoolSlippagePhase =
  | 'idle'
  | 'signing'
  | 'confirming'
  | 'success'
  | 'failed';

export type StakePoolSlippageState = {
  phase: StakePoolSlippagePhase;
  symbol?: string;
  hash?: Hex;
  error?: string;
};

const POLL_TIMEOUT_MS = 90_000;
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
      // eslint-disable-next-line no-console
      console.warn('[cardo stake-pool-slippage] receipt poll error', e);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`receipt poll timed out for ${hash}`);
}

export function useStakePoolDepositSolWithSlippage() {
  const [state, setState] = useState<StakePoolSlippageState>({ phase: 'idle' });
  const { writeContractAsync } = useRomeWrite();

  const deposit = useCallback(
    async (opts: {
      userEvmAddress: Address;
      entry: StakePoolRegistryEntry;
      lamports: bigint;
      minimumPoolTokensOut: bigint;
    }) => {
      setState({ phase: 'idle', symbol: opts.entry.symbol });
      try {
        const built = buildDepositSolWithSlippageInvoke({
          userEvmAddress: opts.userEvmAddress,
          pool: opts.entry.pool,
          lamports: opts.lamports,
          minimumPoolTokensOut: opts.minimumPoolTokensOut,
        });
        setState({ phase: 'signing', symbol: opts.entry.symbol });
        const hash = await writeContractAsync({
          address: CPI_PRECOMPILE,
          abi: CPI_INVOKE_ABI,
          functionName: 'invoke',
          args: [built.program, built.accounts, built.data],
        });
        setState({ phase: 'confirming', symbol: opts.entry.symbol, hash });
        const r = await waitForReceipt(hash);
        if (r.status === 'reverted') {
          setState({
            phase: 'failed',
            symbol: opts.entry.symbol,
            hash,
            error:
              'DepositSolWithSlippage reverted. Likely caused by realized output below your minimum (slippage guard) or pool gates.',
          });
          return;
        }
        setState({ phase: 'success', symbol: opts.entry.symbol, hash });
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        setState((prev) => ({ ...prev, phase: 'failed', error: msg }));
      }
    },
    [writeContractAsync],
  );

  const reset = useCallback(() => setState({ phase: 'idle' }), []);
  return { state, deposit, reset };
}

export function useStakePoolWithdrawSolWithSlippage() {
  const [state, setState] = useState<StakePoolSlippageState>({ phase: 'idle' });
  const { writeContractAsync } = useRomeWrite();

  const withdraw = useCallback(
    async (opts: {
      userEvmAddress: Address;
      entry: StakePoolRegistryEntry;
      poolTokensIn: bigint;
      minimumLamportsOut: bigint;
    }) => {
      setState({ phase: 'idle', symbol: opts.entry.symbol });
      try {
        const built = buildWithdrawSolWithSlippageInvoke({
          userEvmAddress: opts.userEvmAddress,
          pool: opts.entry.pool,
          poolTokensIn: opts.poolTokensIn,
          minimumLamportsOut: opts.minimumLamportsOut,
        });
        setState({ phase: 'signing', symbol: opts.entry.symbol });
        const hash = await writeContractAsync({
          address: CPI_PRECOMPILE,
          abi: CPI_INVOKE_ABI,
          functionName: 'invoke',
          args: [built.program, built.accounts, built.data],
        });
        setState({ phase: 'confirming', symbol: opts.entry.symbol, hash });
        const r = await waitForReceipt(hash);
        if (r.status === 'reverted') {
          setState({
            phase: 'failed',
            symbol: opts.entry.symbol,
            hash,
            error:
              'WithdrawSolWithSlippage reverted. Likely caused by realized lamports below your minimum (slippage guard).',
          });
          return;
        }
        setState({ phase: 'success', symbol: opts.entry.symbol, hash });
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        setState((prev) => ({ ...prev, phase: 'failed', error: msg }));
      }
    },
    [writeContractAsync],
  );

  const reset = useCallback(() => setState({ phase: 'idle' }), []);
  return { state, withdraw, reset };
}
