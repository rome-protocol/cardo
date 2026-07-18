// useInboundWhSend — ETH inbound via Wormhole (source EVM → Rome), quote-first
// against the bridge-api pod.
//
// ONE user signature: the QUOTE's wrapAndTransferETH (value = the ETH amount),
// signed verbatim (§7.4). Registration follows — no settle signature (wETH is
// never gas; the credit is always the wrapped token). The pod's sponsor
// verifies guardian signatures, posts the VAA, and completes the transfer.
// Sender is EVM-only: the pod derives the Solana destination from `recipient`.

import { useCallback } from 'react';
import { useChainId, useSendTransaction, useSwitchChain, usePublicClient } from 'wagmi';
import { parseEther } from 'viem';
import { useActiveChainId, useEnv } from './env-context';
import { activeChain } from './chain-config';
import { requestQuote, registerTransfer } from './bridge-api-client';
import { inboundWhQuoteRequest, userSignedTxs, step1BindingTxIndex } from './bridge-flows';
import type { OnBridgeStep } from './use-inbound-cctp-send';

export interface InboundWhResult {
  sepoliaTxHash: `0x${string}`;
  recipientAta: string;
  amountRaw: string;
  /** Pod transfer id — poll GET /v1/transfers/:id. Absent = registration failed (tx recoverable by hash). */
  transferId?: string;
}

export function useInboundWhSend() {
  const romeChainId = useActiveChainId();
  const { bridgeApiBase } = useEnv();
  const walletChainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  const { sendTransactionAsync } = useSendTransaction();
  const bridge = activeChain(romeChainId).bridge;
  const src = bridge?.sourceEvm;
  const pub = usePublicClient({ chainId: src?.chainId });

  return useCallback(
    async (params: {
      amount: string;
      evmAddress: `0x${string}`;
      onStep?: OnBridgeStep;
    }): Promise<InboundWhResult> => {
      const onStep = params.onStep;
      if (!bridge || !src) {
        throw new Error('Wormhole bridge is not configured for the active chain (chain.bridge missing).');
      }
      const api = { base: bridgeApiBase };
      const valueWei = parseEther(params.amount);

      const quote = await requestQuote(inboundWhQuoteRequest({
        sourceChainId: src.chainId,
        romeChainId,
        amount: valueWei,
        evmAddress: params.evmAddress,
      }), api);
      const txs = userSignedTxs(quote, 'eth-wormhole-to-rome');
      const recipientAta = quote.steps.find((s) => s.recipientAta)?.recipientAta ?? '';

      if (walletChainId !== src.chainId) {
        try {
          await switchChainAsync({ chainId: src.chainId });
        } catch (err) {
          throw new Error(
            `Could not switch your wallet to ${src.name}. Switch networks manually and try again. (${(err as Error)?.message ?? err})`,
          );
        }
      }

      const hashes: `0x${string}`[] = [];
      for (let i = 0; i < txs.length; i++) {
        const { tx } = txs[i]!;
        onStep?.(i, 'awaiting');
        let hash: `0x${string}`;
        try {
          hash = await sendTransactionAsync({
            to: tx.to,
            data: tx.data,
            ...(tx.value !== undefined && tx.value !== '0' ? { value: BigInt(tx.value) } : {}),
          });
        } catch (err) {
          const msg = (err as Error)?.message ?? String(err);
          if (/user rejected|User denied/i.test(msg)) throw err;
          throw new Error(`Wormhole wrapAndTransferETH on ${src.name} failed: ${msg}`);
        }
        onStep?.(i, 'confirming');
        if (pub) await pub.waitForTransactionReceipt({ hash });
        hashes.push(hash);
      }
      const wrapTx = hashes[step1BindingTxIndex(txs)]!;

      let transferId: string | undefined;
      try {
        const record = await registerTransfer({ quote, step1TxHash: wrapTx }, api);
        transferId = record.id;
      } catch {
        /* surfaced via transferId: undefined */
      }

      return {
        sepoliaTxHash: wrapTx,
        recipientAta,
        amountRaw: valueWei.toString(),
        ...(transferId !== undefined ? { transferId } : {}),
      };
    },
    [bridge, src, romeChainId, bridgeApiBase, walletChainId, switchChainAsync, sendTransactionAsync, pub],
  );
}
