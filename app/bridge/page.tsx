// Bridge route /bridge — BIDIRECTIONAL bridge between Sepolia (Ethereum) and
// Rome, as a direct client of the rome-bridge-api pod (browser → pod; CORS *).
//   IN  (Sepolia → Rome): hook quotes the pod, user signs the QUOTE's txs,
//        signs the EIP-712 settle authorization (CCTP gas intent), and the
//        hook registers the transfer; the pod's sponsor attests + mints +
//        settles. The page polls GET /v1/transfers/:id for honest status.
//   OUT (Rome → Sepolia): user signs the QUOTE's Rome-side burn; CCTP-out is
//        registered (pod materializes the destination claim); Wormhole-out is
//        burn + VAA + portal redeem (pod registration lands with WH-out parity).
// NO settlement logic and NO local calldata here — the pod owns both.

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bridge } from '@/components/screens/Bridge';
import { useWallet } from '../wallet-context';
import { useActiveChainId, useEnv } from '@/lib/env-context';
import { activeChain } from '@/lib/chain-config';
import { getTransfer } from '@/lib/bridge-api-client';
import { transferFlowStatus } from '@/lib/bridge-flows';
import { useInboundCctpSend } from '@/lib/use-inbound-cctp-send';
import { useInboundWhSend } from '@/lib/use-inbound-wh-send';
import { useOutboundCctpSend } from '@/lib/use-outbound-cctp-send';
import { useOutboundWhSend } from '@/lib/use-outbound-wh-send';

type Phase = 'idle' | 'awaiting' | 'confirming' | 'submitting' | 'submitted' | 'failed';
type Flow = {
  phase: Phase;
  stepIndex: number;
  stepCount: number;
  direction?: 'in' | 'out';
  txHash?: string;
  statusPhase?: string;
  statusOutcome?: string;
  error?: string;
};

const isAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test((a || '').trim());

export default function Page() {
  const { wallet, connect } = useWallet();
  const romeChainId = useActiveChainId();
  const { bridgeApiBase } = useEnv();
  const cfg = activeChain(romeChainId);
  const bridge = cfg.bridge;
  const inboundCctp = useInboundCctpSend();
  const inboundWh = useInboundWhSend();
  const outboundCctp = useOutboundCctpSend();
  const outboundWh = useOutboundWhSend();
  const [flow, setFlow] = useState<Flow>({ phase: 'idle', stepIndex: 0, stepCount: 0 });

  const assets = useMemo(() => {
    if (!bridge) return [];
    const gasMint = cfg.chainMintId;
    return bridge.assets.map((x) => ({
      id: x.id,
      symbol: x.symbol,
      name: x.name,
      protocol: x.protocol,
      decimals: x.decimals,
      settlesAsGas: x.solanaMint === gasMint,
    }));
  }, [bridge, cfg.chainMintId]);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);
  useEffect(() => stopPoll, [stopPoll]);

  // Poll the pod's transfer record; map to the screen's phase/outcome strings.
  const startPoll = useCallback(
    (transferId: string, txHash: string) => {
      stopPoll();
      const tick = async () => {
        try {
          const record = await getTransfer(transferId, { base: bridgeApiBase });
          const status = transferFlowStatus(record);
          setFlow((f) => (f.txHash === txHash
            ? { ...f, statusPhase: status.phase, ...(status.outcome !== undefined ? { statusOutcome: status.outcome } : {}) }
            : f));
          if (status.phase === 'complete' || status.phase === 'failed') stopPoll();
        } catch {
          /* transient — keep polling */
        }
      };
      void tick();
      pollRef.current = setInterval(tick, 8_000);
    },
    [stopPoll, bridgeApiBase],
  );

  const onBridge = useCallback(
    async ({ direction, assetId, amount, recipient }: { direction: 'in' | 'out'; assetId: string; amount: string; recipient: string }) => {
      if (!wallet?.address) {
        connect?.();
        return;
      }
      if (!bridge) return;
      const asset = bridge.assets.find((x) => x.id === assetId);
      if (!asset) return;
      const protocol = asset.protocol;
      const evmAddress = wallet.address as `0x${string}`;
      const amt = BigInt(Math.floor(parseFloat(amount) * 10 ** asset.decimals));
      if (amt <= 0n) {
        setFlow({ phase: 'idle', stepIndex: 0, stepCount: 0 });
        return;
      }

      // sig count differs by direction: IN cctp=2/wh=1; OUT cctp=1/wh=2.
      // (+1 gasless EIP-712 settle signature on IN cctp, not counted here.)
      const stepCount = protocol === 'cctp' ? (direction === 'out' ? 1 : 2) : direction === 'out' ? 2 : 1;
      const onStep = (index: number, phase: 'awaiting' | 'confirming') =>
        setFlow((f) => ({ ...f, phase, stepIndex: index, stepCount, direction }));
      setFlow({ phase: 'awaiting', stepIndex: 0, stepCount, direction });

      try {
        let txHash: `0x${string}`;
        let transferId: string | undefined;

        if (direction === 'out') {
          const ethRecipient = (isAddr(recipient) ? recipient.trim() : evmAddress) as `0x${string}`;
          if (protocol === 'cctp') {
            const result = await outboundCctp({ amount: amt, ethereumRecipient: ethRecipient, evmAddress, onStep });
            txHash = result.romeTxHash;
            transferId = result.transferId;
          } else {
            // Display string, not the 8-dec amt — the hook converts to wei
            // (the pod's ETH API unit).
            const result = await outboundWh({ amount, ethereumRecipient: ethRecipient, evmAddress, onStep });
            txHash = result.romeTxHash;
            // Wormhole-out: burn + VAA + portal redeem; no pod record yet.
          }
        } else {
          if (protocol === 'cctp') {
            const result = await inboundCctp({ amount: amt, evmAddress, onStep });
            txHash = result.sepoliaTxHash;
            transferId = result.transferId;
          } else {
            const result = await inboundWh({ amount, evmAddress, onStep });
            txHash = result.sepoliaTxHash;
            transferId = result.transferId;
          }
        }

        setFlow({ phase: 'submitted', stepIndex: stepCount - 1, stepCount, direction, txHash });
        if (transferId) {
          startPoll(transferId, txHash);
        } else if (direction === 'in' || protocol === 'cctp') {
          // Registration failed — the burn is on-chain and recoverable by hash;
          // say so instead of pretending progress.
          setFlow((f) => (f.txHash === txHash ? { ...f, statusPhase: 'registration-failed' } : f));
        }
      } catch (e) {
        const msg = (e as Error)?.message ?? String(e);
        if (/user rejected|User denied/i.test(msg)) {
          setFlow({ phase: 'idle', stepIndex: 0, stepCount: 0 });
          return;
        }
        setFlow({ phase: 'failed', stepIndex: 0, stepCount, direction, error: msg });
      }
    },
    [wallet?.address, connect, bridge, inboundCctp, inboundWh, outboundCctp, outboundWh, startPoll],
  );

  return (
    <Bridge
      wallet={wallet}
      onConnect={connect}
      assets={assets}
      sourceName={bridge?.sourceEvm.name ?? 'Sepolia'}
      sourceExplorer={bridge?.sourceEvm.explorerUrl ?? 'https://sepolia.etherscan.io'}
      romeExplorer={cfg.explorerUrl}
      nativeSymbol={cfg.nativeCurrency.symbol}
      configured={!!bridge}
      flow={flow}
      onBridge={onBridge}
    />
  );
}
