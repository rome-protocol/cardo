// useEnsurePdaLamports — ensure the user's Rome PDA holds enough SOL lamports
// to pay rent for accounts that a subsequent CPI will create on Solana.
//
// WHY: some Solana CPIs create accounts internally (e.g. Streamflow create_v2
// makes metadata + escrow + ATAs; stake-pool deposit; etc.). Their rent is
// paid by the SIGNER — the user's `external_auth` PDA. A fresh EVM user's PDA
// holds 0 lamports, so those CPIs revert with InsufficientFunds.
//
// FIX: HelperProgram.swap_gas_to_lamports(lamports) (precompile 0xff..09) is
// the "operator fronts lamports, user pays in gas" primitive — it credits the
// caller's PDA with SOL and persists. We fund a reserve when the PDA is low,
// as a SEPARATE tx (the lamports persist), then the account-creating CPI runs
// as its own single CPI. We deliberately do NOT stack the funding + the CPI in
// one tx: two write CPIs in one tx is only safe while atomic and otherwise
// trips Rome's CpiProhibitedInIterativeTx / CannotRevertCpi. Separate +
// persisting is simpler and risk-free.
//
// GENERIC: not Streamflow-specific. Any flow whose CPI creates accounts calls
// ensure() before submitting.

import { useCallback, useState } from 'react';
import { useRomeWrite } from './use-rome-write';
import type { Address } from 'viem';
import { deriveRomeUserPda, bytes32ToPublicKey } from './solana-pda';
import { HELPER_PRECOMPILE_ADDR } from './wrap-unwrap-fabric';

const SWAP_GAS_TO_LAMPORTS_ABI = [
  {
    type: 'function',
    name: 'swap_gas_to_lamports',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'lamports', type: 'uint64' }],
    outputs: [],
  },
] as const;

const RPC = '/api/rpc/solana-devnet';
const POLL_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 2_000;

/// Default thresholds (lamports). create_v2 rent measured ~12.6M on Hadrian;
/// fund a multi-stream reserve when below one-stream's worth so we re-fund
/// rarely. Callers can override per-flow.
export const DEFAULT_MIN_LAMPORTS = 15_000_000n; // ~0.015 SOL — below this, refund
export const DEFAULT_RESERVE_LAMPORTS = 30_000_000n; // ~0.03 SOL reserve (covers ~2 streams)

export type EnsurePdaPhase = 'idle' | 'checking' | 'funding' | 'ready' | 'failed';
export type EnsurePdaState = { phase: EnsurePdaPhase; hash?: `0x${string}`; error?: string };

async function pdaLamports(evmAddress: Address): Promise<bigint | null> {
  try {
    const pda = bytes32ToPublicKey(deriveRomeUserPda(evmAddress)).toBase58();
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [pda] }),
    });
    const json = await res.json();
    const v = json.result?.value;
    return typeof v === 'number' ? BigInt(v) : null;
  } catch {
    return null;
  }
}

async function waitForReceipt(hash: `0x${string}`): Promise<'success' | 'reverted'> {
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    try {
      const res = await fetch('/api/rpc/rome', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [hash] }),
      });
      const json = await res.json();
      if (json.result?.blockNumber) return json.result.status === '0x1' ? 'success' : 'reverted';
    } catch {
      /* keep polling */
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`receipt poll timed out for ${hash}`);
}

export function useEnsurePdaLamports() {
  const [state, setState] = useState<EnsurePdaState>({ phase: 'idle' });
  const { writeContractAsync } = useRomeWrite();

  /// Ensure the user PDA holds ≥ minLamports; if not, swap_gas_to_lamports a
  /// reserve. Returns 'ready' once funded (or already sufficient), 'failed'
  /// otherwise. Safe to call before every account-creating CPI — it's a no-op
  /// when the PDA is already funded.
  const ensure = useCallback(
    async (
      userEvmAddress: Address,
      opts: { minLamports?: bigint; reserveLamports?: bigint } = {},
    ): Promise<'ready' | 'failed'> => {
      const min = opts.minLamports ?? DEFAULT_MIN_LAMPORTS;
      const reserve = opts.reserveLamports ?? DEFAULT_RESERVE_LAMPORTS;
      setState({ phase: 'checking' });
      const have = await pdaLamports(userEvmAddress);
      // Unknown balance (RPC hiccup): fund defensively rather than risk an
      // InsufficientFunds revert on the real CPI.
      if (have !== null && have >= min) {
        setState({ phase: 'ready' });
        return 'ready';
      }
      try {
        setState({ phase: 'funding' });
        const hash = await writeContractAsync({
          address: HELPER_PRECOMPILE_ADDR,
          abi: SWAP_GAS_TO_LAMPORTS_ABI,
          functionName: 'swap_gas_to_lamports',
          args: [reserve],
          // swap_gas_to_lamports charges ~`reserve` + execution overhead in EVM
          // gas (it debits the lamport amount it credits to the PDA), so the
          // gas LIMIT must exceed the reserve. Add generous headroom.
          gas: reserve + 20_000_000n,
        });
        const r = await waitForReceipt(hash);
        if (r === 'reverted') {
          setState({ phase: 'failed', hash, error: 'swap_gas_to_lamports reverted' });
          return 'failed';
        }
        // The EVM receipt is `success`, but the credited lamports land on the
        // Solana follower, which can lag the receipt. A CPI fired immediately
        // after (Streamflow create_v2, stake deposit, …) reads the follower's
        // PDA balance for escrow/account rent and reverts InsufficientFunds if
        // it hasn't caught up — the /pay "reverts on first try, passes on retry"
        // flake. Wait until the follower actually reflects the funding before
        // returning 'ready' so the caller's CPI sees the lamports.
        const settleStart = Date.now();
        while (Date.now() - settleStart < 15_000) {
          const have2 = await pdaLamports(userEvmAddress);
          if (have2 !== null && have2 >= min) break;
          await new Promise((res) => setTimeout(res, 1_500));
        }
        setState({ phase: 'ready', hash });
        return 'ready';
      } catch (e) {
        setState({ phase: 'failed', error: (e as Error).message ?? String(e) });
        return 'failed';
      }
    },
    [writeContractAsync],
  );

  const reset = useCallback(() => setState({ phase: 'idle' }), []);
  return { state, ensure, reset };
}
