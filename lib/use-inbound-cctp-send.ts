// useInboundCctpSend — USDC inbound via CCTP (source EVM → Rome), quote-first
// against the bridge-api pod.
//
// Flow: POST /v1/quote (gas intent) → sign the QUOTE's [approve, depositForBurn]
// verbatim on the source chain (§7.4 equality verification kills local
// calldata) → sign the quote's EIP-712 SettleAuthorization over a filled copy
// (sourceTxHash = the burn) → POST /v1/transfers. The pod's sponsor attests,
// mints, and settles — this hook never derives calldata or destinations.
//
// Fund-safety: the burn precedes the settle signature. Declining the signature
// must NOT abandon the transfer (the burn is irreversible) — it still registers,
// the credit arrives as wrapper instead of gas (degradation: settle-skipped).

import { useCallback } from 'react';
import { useChainId, useSendTransaction, useSignTypedData, useSwitchChain, usePublicClient } from 'wagmi';
import { useActiveChainId, useEnv } from './env-context';
import { activeChain } from './chain-config';
import { requestQuote, registerTransfer, settleTypedDataWithBurn } from './bridge-api-client';
import { inboundCctpQuoteRequest, userSignedTxs, step1BindingTxIndex } from './bridge-flows';

/// Step-progress phases for the page's "Sign in wallet (X of N)" UI.
export type BridgeStepPhase = 'awaiting' | 'confirming';
export type OnBridgeStep = (index: number, phase: BridgeStepPhase) => void;

export interface InboundCctpResult {
  sepoliaTxHash: `0x${string}`;
  recipientAta: string;
  amountRaw: string;
  /** Pod transfer id — poll GET /v1/transfers/:id. Absent = registration failed (burn recoverable by hash). */
  transferId?: string;
  /** True when the user declined the settle signature (wrapper credit, not gas). */
  settleDeclined?: boolean;
}

export function useInboundCctpSend() {
  const romeChainId = useActiveChainId();
  const { bridgeApiBase } = useEnv();
  const walletChainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  const { sendTransactionAsync } = useSendTransaction();
  const { signTypedDataAsync } = useSignTypedData();
  const bridge = activeChain(romeChainId).bridge;
  const src = bridge?.sourceEvm;
  const pub = usePublicClient({ chainId: src?.chainId });

  return useCallback(
    async (params: {
      amount: bigint;
      evmAddress: `0x${string}`;
      onStep?: OnBridgeStep;
    }): Promise<InboundCctpResult> => {
      const onStep = params.onStep;
      if (!bridge || !src) {
        throw new Error('CCTP bridge is not configured for the active chain (chain.bridge missing).');
      }
      const api = { base: bridgeApiBase };

      // 1) Quote — the pod owns calldata, destination derivation, and the
      // settle authorization template.
      const quote = await requestQuote(inboundCctpQuoteRequest({
        sourceChainId: src.chainId,
        romeChainId,
        amount: params.amount,
        evmAddress: params.evmAddress,
      }), api);
      const txs = userSignedTxs(quote, 'usdc-cctp-to-rome');
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

      // 2) Sign the quote's txs verbatim ([approve, depositForBurn]). Setup
      // txs wait their receipts (the burn's gas estimate reverts without the
      // allowance); the BURN does not — the settle authorization binds only
      // the hash, so prompting immediately deletes a full source-block (~13s
      // Sepolia) of dead time before the last popup. The burn confirms in
      // parallel with Circle's attestation; a dropped burn just leaves a
      // record that never attests (pod-side expiry covers it).
      const hashes: `0x${string}`[] = [];
      for (let i = 0; i < txs.length; i++) {
        const { tx } = txs[i]!;
        const isLast = i === txs.length - 1;
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
          throw new Error(`${tx.description ?? 'CCTP transaction'} on ${src.name} failed: ${msg}`);
        }
        onStep?.(i, 'confirming');
        if (!isLast && pub) await pub.waitForTransactionReceipt({ hash });
        hashes.push(hash);
      }
      const burnTx = hashes[step1BindingTxIndex(txs)]!;

      // 3) Trustless settle authorization: sign a FILLED COPY (burn hash in
      // message.sourceTxHash); the quote itself is submitted verbatim.
      let userSettleSig: string | undefined;
      let settleDeclined = false;
      const typedData = settleTypedDataWithBurn(quote, burnTx);
      if (typedData) {
        try {
          // Runtime-shaped typed-data from the pod — statically opaque to
          // wagmi's generic, hence the one-shot cast.
          userSettleSig = await signTypedDataAsync({
            domain: typedData.domain,
            types: typedData.types,
            primaryType: typedData.primaryType,
            message: typedData.message,
          } as unknown as Parameters<typeof signTypedDataAsync>[0]);
        } catch {
          settleDeclined = true; // burn already happened — register anyway (wrapper credit)
        }
      }

      // 4) Register. A failed registration must not lose the burn — the hash
      // stays recoverable; transferId simply comes back absent.
      let transferId: string | undefined;
      try {
        const record = await registerTransfer({
          quote,
          step1TxHash: burnTx,
          ...(userSettleSig !== undefined ? { userSettleSig } : {}),
        }, api);
        transferId = record.id;
      } catch {
        /* surfaced via transferId: undefined */
      }

      return {
        sepoliaTxHash: burnTx,
        recipientAta,
        amountRaw: params.amount.toString(),
        ...(transferId !== undefined ? { transferId } : {}),
        ...(settleDeclined ? { settleDeclined } : {}),
      };
    },
    [bridge, src, romeChainId, bridgeApiBase, walletChainId, switchChainAsync, sendTransactionAsync, signTypedDataAsync, pub],
  );
}
