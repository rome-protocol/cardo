// useOutboundWhSend — ETH outbound via Wormhole (Rome → Sepolia), quote-first
// against the bridge-api pod.
//
// TWO signatures on ROME: the QUOTE's approveBurnETH (step 1) then burnETH
// (step 2) — signed verbatim; the pod owns the calldata. The burn posts the
// Wormhole publishMessage; the user redeems on Sepolia (Wormhole portal) once
// the VAA is signed — user-paid, same as today.
//
// NOT registered with the pod: POST /v1/transfers verifies from-rome burns via
// its CCTP stamp only — the Wormhole-out route has no registration/claim
// support pod-side yet (spec Open Q3). The flow is complete without it (burn +
// VAA + portal redeem); registration lands with the pod's WH-out parity work.

import { useCallback } from 'react';
import { useChainId, useSendTransaction, useSwitchChain, usePublicClient } from 'wagmi';
import { parseEther } from 'viem';
import { useActiveChainId, useEnv } from './env-context';
import { activeChain } from './chain-config';
import { useEnsurePdaLamports } from './use-ensure-pda-lamports';
import { romeFeeOverrides } from './rome-fee';
import { requestQuote } from './bridge-api-client';
import { outboundWhQuoteRequest, userSignedTxs } from './bridge-flows';
import type { OnBridgeStep } from './use-inbound-cctp-send';

export interface OutboundWhResult {
  approveTxHash: `0x${string}`;
  romeTxHash: `0x${string}`;
  amountRaw: string;
  recipient: string;
}

export function useOutboundWhSend() {
  const romeChainId = useActiveChainId();
  const { bridgeApiBase } = useEnv();
  const walletChainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  const { sendTransactionAsync } = useSendTransaction();
  const { ensure: ensureLamports } = useEnsurePdaLamports();
  const pub = usePublicClient({ chainId: romeChainId });
  const bridge = activeChain(romeChainId).bridge;

  return useCallback(
    async (params: {
      /** Display amount ("0.001") — the pod's ETH API unit is 18-dec wei, NOT
       * the 8-dec wETH wrapper unit the balance surfaces use. */
      amount: string;
      ethereumRecipient: `0x${string}`;
      evmAddress: `0x${string}`;
      onStep?: OnBridgeStep;
    }): Promise<OutboundWhResult> => {
      const onStep = params.onStep;
      if (!bridge) throw new Error('Bridge is not configured for the active chain (chain.bridge missing).');
      const valueWei = parseEther(params.amount);

      const quote = await requestQuote(outboundWhQuoteRequest({
        romeChainId,
        amount: valueWei,
        evmAddress: params.evmAddress,
        recipient: params.ethereumRecipient,
      }), { base: bridgeApiBase });
      // [approve (step 1), burn (step 2)] — both user-signed on Rome.
      const txs = userSignedTxs(quote, 'eth-wormhole-from-rome');

      if (walletChainId !== romeChainId) {
        try {
          await switchChainAsync({ chainId: romeChainId });
        } catch (err) {
          throw new Error(`Could not switch your wallet to Rome. Switch manually and retry. (${(err as Error)?.message ?? err})`);
        }
      }

      // The burn touches a Wormhole message account whose rent is paid by the
      // user's Rome PDA — fund it first (same helper as the other rent-bearing routes).
      const funded = await ensureLamports(params.evmAddress, {
        minLamports: 20_000_000n,
        reserveLamports: 20_000_000n,
      });
      if (funded !== 'ready') throw new Error('Could not fund your Rome PDA for the Wormhole burn rent.');

      const hashes: `0x${string}`[] = [];
      for (let i = 0; i < txs.length; i++) {
        const { tx } = txs[i]!;
        // Explicit fees (Rome baseFee=0 → MetaMask estimate fails). The burn's
        // estimate may revert before the approve lands — the helper falls back
        // to a ceiling in that case.
        const fee = await romeFeeOverrides(pub, { account: params.evmAddress, to: tx.to, data: tx.data });
        onStep?.(i, 'awaiting');
        let hash: `0x${string}`;
        try {
          hash = await sendTransactionAsync({
            to: tx.to,
            data: tx.data,
            ...(tx.value !== undefined && tx.value !== '0' ? { value: BigInt(tx.value) } : {}),
            ...fee,
          });
        } catch (err) {
          const msg = (err as Error)?.message ?? String(err);
          if (/user rejected|User denied/i.test(msg)) throw err;
          throw new Error(`Wormhole ${i === 0 ? 'approveBurnETH' : 'burnETH'} on Rome failed: ${msg}`);
        }
        onStep?.(i, 'confirming');
        hashes.push(hash);
      }

      return {
        approveTxHash: hashes[0]!,
        romeTxHash: hashes[hashes.length - 1]!,
        amountRaw: valueWei.toString(),
        recipient: params.ethereumRecipient,
      };
    },
    [bridge, romeChainId, bridgeApiBase, walletChainId, switchChainAsync, sendTransactionAsync, ensureLamports, pub],
  );
}
