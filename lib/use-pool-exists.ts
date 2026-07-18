// usePoolExists — pre-flight check: does a Meteora DAMM v1 pool
// already exist at the deterministic PDA for this (mintA, mintB,
// feeBps) triple? If yes, the createPool tx will revert with
// AccountAlreadyInitialized — we surface this in the UI before the
// user signs.

import { useEffect, useState } from 'react';
import type { Address, Hex } from 'viem';
import { derivePoolCreateAddresses } from './meteora-pool-create';
import { METEORA_DAMMV1_PROGRAM } from './meteora-pool';
import { bytes32ToPublicKey } from './solana-pda';

export type PoolExistsResult = {
  poolAddress: string | null;
  exists: 'unknown' | 'exists' | 'missing';
  loading: boolean;
};

export function usePoolExists(args: {
  userEvmAddress: Address | undefined;
  mintAHex: Hex | undefined;
  mintBHex: Hex | undefined;
  tradeFeeBps: bigint | undefined;
}): PoolExistsResult {
  const [state, setState] = useState<PoolExistsResult>({
    poolAddress: null,
    exists: 'unknown',
    loading: false,
  });

  const dep =
    args.userEvmAddress && args.mintAHex && args.mintBHex && args.tradeFeeBps
      ? `${args.userEvmAddress}|${args.mintAHex}|${args.mintBHex}|${args.tradeFeeBps}`
      : '';

  useEffect(() => {
    if (
      !args.userEvmAddress ||
      !args.mintAHex ||
      !args.mintBHex ||
      args.tradeFeeBps === undefined
    ) {
      setState({ poolAddress: null, exists: 'unknown', loading: false });
      return;
    }
    if (args.mintAHex.toLowerCase() === args.mintBHex.toLowerCase()) {
      setState({ poolAddress: null, exists: 'unknown', loading: false });
      return;
    }
    let cancelled = false;
    let pool;
    try {
      const addrs = derivePoolCreateAddresses({
        userEvmAddress: args.userEvmAddress,
        mintAHex: args.mintAHex,
        mintBHex: args.mintBHex,
        tradeFeeBps: args.tradeFeeBps,
      });
      pool = addrs.pool;
    } catch {
      setState({ poolAddress: null, exists: 'unknown', loading: false });
      return;
    }
    setState({ poolAddress: pool.toBase58(), exists: 'unknown', loading: true });

    const tick = async () => {
      try {
        const expectedOwner = bytes32ToPublicKey(METEORA_DAMMV1_PROGRAM).toBase58();
        const res = await fetch('/api/rpc/solana-devnet', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getAccountInfo',
            params: [pool.toBase58(), { encoding: 'base64' }],
          }),
        });
        const json = await res.json();
        if (cancelled) return;
        const acc = json.result?.value;
        const exists =
          acc && acc.owner === expectedOwner ? 'exists' : 'missing';
        setState({
          poolAddress: pool.toBase58(),
          exists,
          loading: false,
        });
      } catch {
        if (!cancelled) {
          setState({
            poolAddress: pool.toBase58(),
            exists: 'unknown',
            loading: false,
          });
        }
      }
    };
    tick();

    return () => {
      cancelled = true;
    };
  }, [dep]); // eslint-disable-line react-hooks/exhaustive-deps

  return state;
}
