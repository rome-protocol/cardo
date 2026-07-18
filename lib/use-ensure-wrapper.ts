// useEnsureWrapper — single-source-of-truth React hook for "does this
// Solana mint have a usable EVM wrapper on Rome, and if not, deploy
// one".
//
// Every Cardo adapter that joins a coin between Solana and EVM ends up
// at the same lifecycle: lookup → if missing, deploy → bind user → use.
// This hook is the fabric. Adapter pages call it once with the target
// mint, render whatever UI fits their flow, and proceed only when state
// transitions to `ready`.
//
// State machine:
//
//                   ┌──────────┐
//                   │ unknown  │  initial / no mint provided
//                   └────┬─────┘
//                        │ mint provided → lookupWrapper
//                        ▼
//          ┌─────────────────────────────┐
//          │ checking                    │
//          └────┬─────────────────┬──────┘
//               │ wrapper found   │ not found
//               ▼                 ▼
//           ┌────────┐        ┌─────────┐
//           │ exists │        │ missing │  caller invokes ensure()
//           └────────┘        └────┬────┘
//                                  ▼
//                            ┌──────────────┐
//                            │ creating-user│ (skipped if registered)
//                            └──────┬───────┘
//                                   ▼
//                          ┌────────────────────┐
//                          │ deploying-wrapper  │
//                          └─────────┬──────────┘
//                                    ▼
//                           ┌──────────────────┐
//                           │ binding-account  │
//                           └─────────┬────────┘
//                                     ▼
//                                 ┌───────┐
//                                 │ ready │
//                                 └───────┘
//
// `ready` and `exists` are both terminal "wrapper is usable" states; the
// distinction is whether the user just deployed it. Pages should treat
// either as a green light.

import { useCallback, useEffect, useState } from 'react';
import { useReadContract } from 'wagmi';
import { useRomeWrite } from './use-rome-write';
import {
  type Address,
  type Hex,
  decodeEventLog,
  parseAbi,
} from 'viem';
import { ROME_ADDRESSES, romeStaticTokens } from './addresses';
import { useActiveChainId } from './env-context';
import { pubkeyBs58ToBytes32 } from './solana-pda';
import { lookupWrapper } from './wrapper-fabric';

// ─────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────

export type EnsureWrapperPhase =
  | 'unknown'
  | 'checking'
  | 'exists'
  | 'missing'
  | 'creating-user'
  | 'deploying-wrapper'
  | 'binding-account'
  | 'ready'
  | 'failed';

export type EnsureWrapperState = {
  phase: EnsureWrapperPhase;
  /// Resolved wrapper address — set once `phase === 'exists' | 'ready'`.
  wrapper?: Address;
  /// Most-recent tx hash from the deploy flow.
  hash?: Hex;
  error?: string;
};

export type EnsureOpts = {
  /// EVM EOA that will own the wrapper binding. Almost always the
  /// connected wallet. The Rome PDA derives from this.
  userAddress: Address;
  /// Symbol for the wrapper. Must be unique across the canonical
  /// factory (`add_spl_token_no_metadata` reverts on collision).
  symbol: string;
  /// Human-readable name (passed to the factory).
  name: string;
};

// ─────────────────────────────────────────────────────────────────────
// ABIs (keep tight — we only call the four methods this hook needs)
// ─────────────────────────────────────────────────────────────────────

const FACTORY_ABI = parseAbi([
  'function create_user()',
  'function add_spl_token_no_metadata(bytes32 mint, string name, string symbol) returns (address)',
  'function token_by_mint(bytes32) view returns (address)',
  'event TokenCreated(address indexed creator, bytes32 indexed mint, address indexed wrapper, string name, string symbol, uint64 nonce)',
]);

const WRAPPER_ABI = parseAbi([
  'function ensure_token_account(address user) returns (bytes32)',
]);

const POLL_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 2_000;

async function waitForReceipt(hash: Hex) {
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
        return {
          status: json.result.status === '0x1' ? 'success' : 'reverted',
          logs: json.result.logs ?? [],
        } as { status: 'success' | 'reverted'; logs: Array<{ topics: string[]; data: string }> };
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[cardo ensure-wrapper] receipt poll error', e);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`receipt poll timed out for ${hash}`);
}

// ─────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────

export function useEnsureWrapper(mintBs58: string | null) {
  const chainId = useActiveChainId();
  const [state, setState] = useState<EnsureWrapperState>({ phase: 'unknown' });
  const { writeContractAsync } = useRomeWrite();

  // Cheap heuristic: read totalTokens() on the Romeswap factory; if the
  // user has any token-by-symbol read landing for them, assume they
  // already created_user'd. We don't actually need this — the factory
  // is happy to call create_user multiple times — but it lets us skip
  // a wallet popup. v1 keeps things simple and just always passes
  // `factoryRegistered=true` (the create_user step is idempotent).
  const factoryRegistered = true;

  // ── Lookup on mount / mint change ────────────────────────────────────
  //
  // Rome has multiple wrappers per mint (WUSDC at 0x6ed2…, plus older
  // 0x1be9… and the canonical factory's first-deployed 0xe65f…). The
  // canonical `token_by_mint` mapping returns ONE — and not always the
  // user-facing one Cardo wires (verified 2026-04-25). So lookup is:
  //   1. consult the static list (authoritative for the wrappers Cardo
  //      surfaces today)
  //   2. fall back to the canonical factory mapping (covers wrappers
  //      auto-deployed via the factory but not yet in the static list)
  //   3. otherwise → missing → caller can drive the deploy flow
  useEffect(() => {
    if (!mintBs58) {
      setState({ phase: 'unknown' });
      return;
    }
    let cancelled = false;
    setState({ phase: 'checking' });

    // Static-list short-circuit (synchronous, no RPC).
    const staticHit = romeStaticTokens(chainId).find(
      (t) => t.mintAddress === mintBs58,
    );
    if (staticHit) {
      setState({ phase: 'exists', wrapper: staticHit.address as Address });
      return;
    }

    void (async () => {
      try {
        const mintHex: Hex = pubkeyBs58ToBytes32(mintBs58);
        const wrapper = await lookupWrapper({ mintHex });
        if (cancelled) return;
        if (wrapper) setState({ phase: 'exists', wrapper });
        else setState({ phase: 'missing' });
      } catch (e) {
        if (cancelled) return;
        setState({
          phase: 'failed',
          error: (e as Error).message ?? String(e),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mintBs58, chainId]);

  // ── Deploy + bind flow ───────────────────────────────────────────────
  const ensure = useCallback(
    async (opts: EnsureOpts) => {
      if (!mintBs58) return;
      const factory = ROME_ADDRESSES.erc20SplFactoryCanonical as Address;
      const gasPrice = 11_000_000_000n;
      const gas = 200_000_000n;
      try {
        const mintHex: Hex = pubkeyBs58ToBytes32(mintBs58);

        // 1. create_user (only when not already registered).
        if (!factoryRegistered) {
          setState((s) => ({ ...s, phase: 'creating-user' }));
          const h = await writeContractAsync({
            address: factory,
            abi: FACTORY_ABI,
            functionName: 'create_user',
            type: 'legacy',
            gasPrice,
            gas: 10_000_000n,
          });
          setState((s) => ({ ...s, hash: h }));
          const r = await waitForReceipt(h);
          if (r.status === 'reverted') throw new Error('create_user reverted');
        }

        // 2. add_spl_token_no_metadata(mint, name, symbol).
        setState((s) => ({ ...s, phase: 'deploying-wrapper' }));
        const h2 = await writeContractAsync({
          address: factory,
          abi: FACTORY_ABI,
          functionName: 'add_spl_token_no_metadata',
          args: [mintHex, opts.name, opts.symbol],
          type: 'legacy',
          gasPrice,
          gas,
        });
        setState((s) => ({ ...s, hash: h2 }));
        const r2 = await waitForReceipt(h2);
        if (r2.status === 'reverted')
          throw new Error('add_spl_token_no_metadata reverted');

        // Resolve the new wrapper. Try the factory mapping first; fall
        // back to parsing TokenCreated from the deploy receipt.
        let wrapper = await lookupWrapper({ mintHex });
        if (!wrapper) {
          for (const log of r2.logs) {
            try {
              const dec = decodeEventLog({
                abi: FACTORY_ABI,
                topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
                data: log.data as Hex,
              });
              if (dec.eventName === 'TokenCreated') {
                wrapper = (dec.args as { wrapper: Address }).wrapper;
                break;
              }
            } catch {
              /* not a factory event */
            }
          }
        }
        if (!wrapper) throw new Error('wrapper deploy succeeded but address could not be resolved');

        // 3. ensure_token_account(user) — bind the user's PDA-owned
        // ATA to the wrapper. Required before any mint/transfer can
        // succeed for this user.
        setState((s) => ({ ...s, phase: 'binding-account', wrapper }));
        const h3 = await writeContractAsync({
          address: wrapper,
          abi: WRAPPER_ABI,
          functionName: 'ensure_token_account',
          args: [opts.userAddress],
          type: 'legacy',
          gasPrice,
          gas,
        });
        setState((s) => ({ ...s, hash: h3 }));
        const r3 = await waitForReceipt(h3);
        if (r3.status === 'reverted') throw new Error('ensure_token_account reverted');

        setState({ phase: 'ready', wrapper, hash: h3 });
      } catch (e) {
        setState((s) => ({
          ...s,
          phase: 'failed',
          error: (e as Error).message ?? String(e),
        }));
      }
    },
    [mintBs58, writeContractAsync, factoryRegistered],
  );

  return { state, ensure } as const;
}

// ─────────────────────────────────────────────────────────────────────
// Convenience: read-only lookup as a Wagmi-cached hook.
//
// Adapter pages that don't need to drive a deploy can use this to get
// the wrapper address without spinning up the full state machine.
// Returns `undefined` while loading; `null` when the factory has no
// wrapper for this mint.
// ─────────────────────────────────────────────────────────────────────

export function useWrapperByMint(mintBs58: string | null): {
  wrapper: Address | null | undefined;
  loading: boolean;
} {
  const chainId = useActiveChainId();
  // Static-list hit — same short-circuit as `useEnsureWrapper`.
  const staticHit = mintBs58
    ? romeStaticTokens(chainId).find((t) => t.mintAddress === mintBs58)
    : null;
  const mintHex: Hex | undefined =
    mintBs58 && !staticHit ? pubkeyBs58ToBytes32(mintBs58) : undefined;
  const { data, isLoading } = useReadContract({
    address: ROME_ADDRESSES.erc20SplFactoryCanonical as Address,
    abi: parseAbi(['function token_by_mint(bytes32) view returns (address)']),
    functionName: 'token_by_mint',
    args: mintHex ? [mintHex] : undefined,
    chainId,
    query: { enabled: !!mintHex },
  });
  if (staticHit) return { wrapper: staticHit.address as Address, loading: false };
  if (isLoading) return { wrapper: undefined, loading: true };
  if (!data) return { wrapper: null, loading: false };
  const addr = data as Address;
  if (addr === '0x0000000000000000000000000000000000000000') {
    return { wrapper: null, loading: false };
  }
  return { wrapper: addr, loading: false };
}
