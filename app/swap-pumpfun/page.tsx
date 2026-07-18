// Swap-Pumpfun route `/swap-pumpfun` — Pump.fun bonding-curve buy/sell
// against active devnet curves. Pre-graduation half of the memecoin
// lifecycle (PumpSwap covers post-graduation).
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md
// (Family 3 / A6 — memecoin lifecycle).

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useReadContract } from 'wagmi';
import { erc20Abi, type Address, type Hex } from 'viem';
import { SwapPumpfun } from '@/components/screens/SwapPumpfun';
import { useWallet } from '../wallet-context';
import { PUMPFUN_DEFAULT } from '@/lib/pumpfun-config';
import { useBondingCurve } from '@/lib/use-bonding-curve';
import { usePumpFunSwap } from '@/lib/use-pumpfun';
import { useActiveChainId } from '@/lib/env-context';
import {
  bytes32ToPublicKey,
  pubkeyBs58ToBytes32,
} from '@/lib/solana-pda';
import { ROME_ADDRESSES } from '@/lib/addresses';

const RPC = '/api/rpc/solana-devnet';
const SOL_POLL_MS = 8_000;

export default function Page() {
  const { wallet, connect } = useWallet();
  const { state: swapState, swap } = usePumpFunSwap();

  // Track the active mint via URL search params + local override.
  const [mintBs58, setMintBs58] = useState<string>(PUMPFUN_DEFAULT.mintBs58);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const u = new URL(window.location.href);
    const m = u.searchParams.get('mint');
    if (m && m.length >= 32) setMintBs58(m);
  }, []);

  let mintHex: Hex | null = null;
  try {
    mintHex = mintBs58 ? pubkeyBs58ToBytes32(mintBs58) : null;
  } catch {
    mintHex = null;
  }

  const config = useMemo(() => {
    if (!mintHex) return null;
    if (mintBs58 === PUMPFUN_DEFAULT.mintBs58) return PUMPFUN_DEFAULT;
    return {
      mintBs58,
      mintHex,
      symbol: 'MEME',
      decimals: 6,
    };
  }, [mintBs58, mintHex]);

  const curveState = useBondingCurve(mintHex);

  // User's Rome PDA on Solana — owns lamports for SOL spend and the
  // memecoin ATA for the sell side.
  const userPda = useMemo(() => {
    if (!wallet?.address) return null;
    try {
      // Local import to avoid touching the placeholder above.
      const { deriveRomeUserPda } = require('@/lib/solana-pda');
      return deriveRomeUserPda(wallet.address) as Hex;
    } catch {
      return null;
    }
  }, [wallet?.address]);

  const userAta = useMemo(() => {
    if (!userPda || !mintHex) return null;
    try {
      const { deriveAta } = require('@/lib/solana-pda');
      return deriveAta(userPda, mintHex) as Hex;
    } catch {
      return null;
    }
  }, [userPda, mintHex]);

  const userAtaBs58 = useMemo(
    () => (userAta ? bytes32ToPublicKey(userAta).toBase58() : null),
    [userAta],
  );

  const userPdaBs58Resolved = useMemo(
    () => (userPda ? bytes32ToPublicKey(userPda).toBase58() : null),
    [userPda],
  );

  // Memecoin ATA balance (atoms → UI).
  const [memecoinBalance, setMemecoinBalance] = useState(0);
  useEffect(() => {
    if (!userAtaBs58 || !config) {
      setMemecoinBalance(0);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(RPC, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getAccountInfo',
            params: [userAtaBs58, { encoding: 'jsonParsed' }],
          }),
        });
        const j = await r.json();
        if (cancelled) return;
        const amt = j?.result?.value?.data?.parsed?.info?.tokenAmount;
        if (!amt) {
          setMemecoinBalance(0);
          return;
        }
        setMemecoinBalance(Number(amt.amount) / 10 ** Number(amt.decimals));
      } catch {
        if (!cancelled) setMemecoinBalance(0);
      }
    };
    void tick();
    const id = setInterval(tick, SOL_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [userAtaBs58, config]);

  // Native SOL balance — the user's PDA holds lamports. Read via SPL
  // proxy of getAccountInfo at the PDA address.
  const [solBalance, setSolBalance] = useState(0);
  useEffect(() => {
    if (!userPdaBs58Resolved) {
      setSolBalance(0);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(RPC, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getAccountInfo',
            params: [userPdaBs58Resolved, { encoding: 'base64' }],
          }),
        });
        const j = await r.json();
        if (cancelled) return;
        const lamports = j?.result?.value?.lamports ?? 0;
        setSolBalance(Number(lamports) / 1e9);
      } catch {
        if (!cancelled) setSolBalance(0);
      }
    };
    void tick();
    const id = setInterval(tick, SOL_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [userPdaBs58Resolved]);

  // Read user's native gas balance on Rome too — useful for the
  // "what backs your spending" sense.
  const romeChainId = useActiveChainId();
  useReadContract({
    address: ROME_ADDRESSES.tokens.wUsdc as Address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: wallet?.address ? [wallet.address as Address] : undefined,
    chainId: romeChainId,
    query: { enabled: !!wallet?.address },
  });

  type SwapArgs = {
    side: 'buy' | 'sell';
    amountHuman: number;
    quotedOutRaw: bigint;
    slippageBps: number;
  };

  const onSwap = useCallback(
    (args: SwapArgs) => {
      if (!wallet?.address) {
        connect?.();
        return;
      }
      if (!mintHex || !curveState.curve || !config) return;

      const slipMul = BigInt(10_000 - args.slippageBps);
      const slipDenom = 10_000n;

      if (args.side === 'buy') {
        // amountHuman is SOL the user is willing to spend.
        const maxSolCost = BigInt(Math.floor(args.amountHuman * 1e9));
        // Floor on memecoin out — quotedOutRaw scaled down by slippage.
        const baseOut = (args.quotedOutRaw * slipMul) / slipDenom;
        if (maxSolCost <= 0n || baseOut <= 0n) return;
        void swap({
          side: 'buy',
          userEvmAddress: wallet.address as `0x${string}`,
          mintHex,
          curve: curveState.curve,
          amount: baseOut, // memecoin out floor
          maxSolCost,
          trackVolume: true,
        });
      } else {
        // amountHuman is memecoin atoms count.
        const baseIn = BigInt(
          Math.floor(args.amountHuman * 10 ** config.decimals),
        );
        const minSolOut =
          (args.quotedOutRaw * slipMul) / slipDenom;
        if (baseIn <= 0n) return;
        void swap({
          side: 'sell',
          userEvmAddress: wallet.address as `0x${string}`,
          mintHex,
          curve: curveState.curve,
          amount: baseIn,
          minSolOutput: minSolOut,
        });
      }
    },
    [wallet?.address, connect, mintHex, curveState.curve, config, swap],
  );

  return (
    <SwapPumpfun
      wallet={wallet}
      onConnect={connect}
      config={config}
      curveState={curveState}
      memecoinBalance={memecoinBalance}
      solBalance={solBalance}
      onSwap={onSwap}
      swapState={swapState}
      onMintChange={(next: string) => {
        if (next === mintBs58) return;
        setMintBs58(next);
        if (typeof window !== 'undefined') {
          const u = new URL(window.location.href);
          u.searchParams.set('mint', next);
          window.history.replaceState({}, '', u.toString());
        }
      }}
    />
  );
}
