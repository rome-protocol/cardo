// Wallet context — wagmi adapter.
//
// Feeds the designer's V3 wallet shape ({ connected, address, balanceUSD,
// network }) from wagmi hooks, so components/screens/*.jsx don't change:
// they still receive a plain `wallet` object and `onConnect` / `onDisconnect`
// callbacks. Under the hood we read useAccount/useBalance/useChainId and
// open the RainbowKit connect modal.
//
// balanceUSD conversion: we convert the native-token balance (mETH on
// Rome, 18-dec) into USD via the on-chain ETH/USD oracle adapter in
// lib/addresses.ts (Chainlink-compatible latestRoundData). If the oracle
// read fails (network hiccup, no wallet yet), we fall back to 0 — the Nav
// chip shows "$0" which is accurate for an empty/unresolvable state.

'use client';

import React, { createContext, useCallback, useContext, useMemo } from 'react';
import { useAccount, useBalance, useChainId, useDisconnect, useSwitchChain, useReadContract } from 'wagmi';
import { useConnectModal, useAccountModal } from '@rainbow-me/rainbowkit';
import { formatUnits } from 'viem';
import { ROME_ADDRESSES } from '@/lib/addresses';
import { useActiveChainId } from '@/lib/env-context';

// Minimal Chainlink AggregatorV3Interface ABI. Oracle Gateway V2 wraps
// Pyth Pull / Switchboard V3 as Chainlink-compatible so this shape works
// for any of them.
const AGGREGATOR_V3_ABI = [
  {
    name: 'latestRoundData',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
  },
  {
    name: 'decimals',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
] as const;

export type Wallet = {
  connected: boolean;
  address: string | null;
  balanceUSD: number;
  network: 'rome' | 'ethereum' | string;
  // wagmi-specific extras (optional reads for screens that care):
  chainId: number | null;
  isWrongNetwork: boolean;
};

export const DISCONNECTED: Wallet = {
  connected: false,
  address: null,
  balanceUSD: 0,
  network: 'rome',
  chainId: null,
  isWrongNetwork: false,
};

type Ctx = {
  wallet: Wallet;
  connect: () => void;
  disconnect: () => void;
  openAccount: () => void;
  switchToChain: () => void;
};

const WalletCtx = createContext<Ctx | null>(null);

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  // Runtime Rome chain (from /api/env) — the chain Cardo targets, distinct from
  // `chainId` (the wallet's currently-connected chain).
  const romeChainId = useActiveChainId();
  const { disconnect: wagmiDisconnect } = useDisconnect();
  const { switchChainAsync } = useSwitchChain();
  const { openConnectModal } = useConnectModal();
  const { openAccountModal } = useAccountModal();

  // Native balance on current chain. viem returns BigInt + decimals; we
  // format to a JS number for the oracle multiply below.
  const { data: nativeBalance } = useBalance({
    address,
    chainId: romeChainId,
    query: { enabled: !!address, refetchInterval: 15_000 },
  });

  // ETH/USD oracle read — Chainlink-compat latestRoundData + decimals.
  const { data: priceAnswer } = useReadContract({
    address: ROME_ADDRESSES.oracles.ethUsd,
    abi: AGGREGATOR_V3_ABI,
    functionName: 'latestRoundData',
    chainId: romeChainId,
    query: { enabled: isConnected, refetchInterval: 30_000 },
  });
  const { data: priceDecimals } = useReadContract({
    address: ROME_ADDRESSES.oracles.ethUsd,
    abi: AGGREGATOR_V3_ABI,
    functionName: 'decimals',
    chainId: romeChainId,
    query: { enabled: isConnected },
  });

  const balanceUSD = useMemo(() => {
    if (!nativeBalance || !priceAnswer || priceDecimals === undefined) return 0;
    // latestRoundData returns a tuple; answer is index 1.
    const answer = priceAnswer[1] as bigint;
    if (answer <= 0n) return 0;
    const priceNum = Number(formatUnits(answer, Number(priceDecimals)));
    const nativeNum = Number(formatUnits(nativeBalance.value, nativeBalance.decimals));
    return nativeNum * priceNum;
  }, [nativeBalance, priceAnswer, priceDecimals]);

  const isWrongNetwork = isConnected && chainId !== romeChainId;
  const network: Wallet['network'] = !isConnected
    ? 'rome'
    : chainId === romeChainId
      ? 'rome'
      : chainId === 1
        ? 'ethereum'
        : `chain-${chainId}`;

  const connect = useCallback(() => {
    openConnectModal?.();
  }, [openConnectModal]);

  const disconnect = useCallback(() => {
    wagmiDisconnect();
  }, [wagmiDisconnect]);

  const openAccount = useCallback(() => {
    // Fallback to connect modal if the account modal isn't mounted yet
    // (happens during initial hydration before the wagmi connector settles).
    if (openAccountModal) openAccountModal();
    else openConnectModal?.();
  }, [openAccountModal, openConnectModal]);

  const switchToChain = useCallback(() => {
    // switchChainAsync (not fire-and-forget switchChain) is what reliably
    // reaches MetaMask + triggers wallet_addEthereumChain when Rome isn't in the
    // wallet yet. The old fire-and-forget call is why the "Switch network"
    // banner button sometimes appeared to do nothing on the first click.
    switchChainAsync({ chainId: romeChainId }).catch((e) => {
      // eslint-disable-next-line no-console
      console.warn('[cardo] network switch rejected/failed', e);
    });
  }, [switchChainAsync, romeChainId]);

  const wallet = useMemo<Wallet>(
    () => ({
      connected: isConnected,
      address: address ?? null,
      balanceUSD,
      network,
      chainId: chainId ?? null,
      isWrongNetwork,
    }),
    [isConnected, address, balanceUSD, network, chainId, isWrongNetwork],
  );

  const value = useMemo<Ctx>(
    () => ({ wallet, connect, disconnect, openAccount, switchToChain }),
    [wallet, connect, disconnect, openAccount, switchToChain],
  );

  return <WalletCtx.Provider value={value}>{children}</WalletCtx.Provider>;
}

export function useWallet(): Ctx {
  const v = useContext(WalletCtx);
  if (!v) throw new Error('useWallet must be used inside <WalletProvider>');
  return v;
}
