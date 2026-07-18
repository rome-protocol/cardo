// useOutboundCctpSend — USDC outbound via CCTP (Rome → destination EVM),
// quote-first against the bridge-api pod.
//
// ONE signature on ROME: the QUOTE's burnUSDC (RomeBridgeWithdraw v6, 3-arg
// per-destination form), signed verbatim (§7.4). Registration follows; the
// pod's poller watches the Circle attestation and materializes the destination
// claim step (receiveMessage unsignedTxs) with status "ready" — the user then
// claims on the destination (user-paid, same as today).
//
// Rome quirks stay hook-side: the burn writes a CCTP MessageSent account whose
// rent the user's Rome PDA fronts (fund first), and Rome's baseFee=0 breaks
// MetaMask's own fee estimate (explicit overrides via romeFeeOverrides).

import { useCallback } from 'react';
import { useChainId, useSendTransaction, useSwitchChain, usePublicClient } from 'wagmi';
import { useActiveChainId, useEnv } from './env-context';
import { activeChain } from './chain-config';
import { useEnsurePdaLamports } from './use-ensure-pda-lamports';
import { romeFeeOverrides } from './rome-fee';
import { requestQuote, registerTransfer } from './bridge-api-client';
import { outboundCctpQuoteRequest, userSignedTxs, step1BindingTxIndex } from './bridge-flows';
import type { OnBridgeStep } from './use-inbound-cctp-send';

export interface OutboundCctpResult {
  romeTxHash: `0x${string}`;
  amountRaw: string;
  recipient: string;
  /** Pod transfer id — poll GET /v1/transfers/:id for the claim step. Absent = registration failed. */
  transferId?: string;
}

export function useOutboundCctpSend() {
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
      amount: bigint;
      ethereumRecipient: `0x${string}`;
      evmAddress: `0x${string}`;
      onStep?: OnBridgeStep;
    }): Promise<OutboundCctpResult> => {
      const onStep = params.onStep;
      if (!bridge) throw new Error('Bridge is not configured for the active chain (chain.bridge missing).');
      const api = { base: bridgeApiBase };

      const quote = await requestQuote(outboundCctpQuoteRequest({
        destinationChainId: bridge.sourceEvm.chainId,
        romeChainId,
        amount: params.amount,
        evmAddress: params.evmAddress,
        recipient: params.ethereumRecipient,
      }), api);
      const txs = userSignedTxs(quote, 'usdc-cctp-from-rome');

      // Outbound burns on Rome — ensure the wallet is on the Rome chain.
      if (walletChainId !== romeChainId) {
        try {
          await switchChainAsync({ chainId: romeChainId });
        } catch (err) {
          throw new Error(`Could not switch your wallet to Rome. Switch manually and retry. (${(err as Error)?.message ?? err})`);
        }
      }

      // The CCTP burn creates a MessageSent account on Solana whose rent is paid
      // by the user's Rome PDA; a 0-SOL PDA reverts Custom(1). Fund a reserve
      // first (persists) — same generic helper as the other rent-bearing routes.
      const funded = await ensureLamports(params.evmAddress, {
        minLamports: 20_000_000n,
        reserveLamports: 20_000_000n,
      });
      if (funded !== 'ready') throw new Error('Could not fund your Rome PDA for the CCTP burn rent.');

      const hashes: `0x${string}`[] = [];
      for (let i = 0; i < txs.length; i++) {
        const { tx } = txs[i]!;
        // Explicit fees: Rome's baseFee=0 makes MetaMask's own estimate fail
        // ("Network fee Unavailable"). Estimate on-chain + apply a factor.
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
          throw new Error(`CCTP burnUSDC on Rome failed: ${msg}`);
        }
        // Rome's proxy returns the hash once the Solana tx confirms — no receipt wait.
        onStep?.(i, 'confirming');
        hashes.push(hash);
      }
      const burnTx = hashes[step1BindingTxIndex(txs)]!;

      let transferId: string | undefined;
      try {
        const record = await registerTransfer({ quote, step1TxHash: burnTx }, api);
        transferId = record.id;
      } catch {
        /* surfaced via transferId: undefined */
      }

      return {
        romeTxHash: burnTx,
        amountRaw: params.amount.toString(),
        recipient: params.ethereumRecipient,
        ...(transferId !== undefined ? { transferId } : {}),
      };
    },
    [bridge, romeChainId, bridgeApiBase, walletChainId, switchChainAsync, sendTransactionAsync, ensureLamports, pub],
  );
}
