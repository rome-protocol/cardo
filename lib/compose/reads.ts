// Plain async chain reads for the compose executor. The single-dapp
// screens read chain state through polling hooks; the compose executor
// runs its steps sequentially inside one async function, where a hook
// per step is impossible — so it needs imperative, one-shot reads.
//
// Every read hits the same same-origin RPC proxies the hooks use and
// reads at `commitment:'confirmed'` (the #133 lesson: `finalized` lags
// the Rome receipt by ~13s+, which reads as "nothing happened").

import { bytes32ToPublicKey, deriveUserAta } from '../solana-pda';
import type { Address, Hex } from 'viem';

const SOLANA_RPC = '/api/rpc/solana-devnet';
const ROME_RPC = '/api/rpc/rome';

/// `getAccountInfo` at 'confirmed' — true iff the account exists. Used
/// for the Mango-account existence check and the swap's cold out-ATA
/// pre-flight.
export async function readAccountExists(pubkeyBs58: string): Promise<boolean> {
  const res = await fetch(SOLANA_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'getAccountInfo',
      params: [pubkeyBs58, { encoding: 'base64', commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } }],
    }),
  });
  const json = await res.json();
  return !!json?.result?.value;
}

/// Raw SPL amount in the user's ATA for `mintHex`, at 'confirmed'; 0n
/// when the ATA doesn't exist yet. The reconcile primitive: read before
/// and after the swap, deposit the delta.
export async function readAtaAmountRaw(
  userEvmAddress: Address,
  mintHex: Hex,
): Promise<bigint> {
  const ataBs58 = bytes32ToPublicKey(deriveUserAta(userEvmAddress, mintHex)).toBase58();
  const res = await fetch(SOLANA_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'getAccountInfo',
      params: [ataBs58, { encoding: 'jsonParsed', commitment: 'confirmed' }],
    }),
  });
  const json = await res.json();
  const amt = json?.result?.value?.data?.parsed?.info?.tokenAmount?.amount;
  return typeof amt === 'string' && /^\d+$/.test(amt) ? BigInt(amt) : 0n;
}

/// After a swap settles, the Solana follower can lag the Rome receipt by
/// a poll or two. Poll the user's `mintHex` ATA until it exceeds `floor`
/// (its pre-swap balance) and return the reconciled delta — exactly what
/// this swap produced, never a guess. Returns 0n if it never moved.
export async function reconcileAtaDelta(
  userEvmAddress: Address,
  mintHex: Hex,
  floor: bigint,
  opts?: { timeoutMs?: number },
): Promise<bigint> {
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  const start = Date.now();
  let last = 0n;
  while (Date.now() - start < timeoutMs) {
    last = await readAtaAmountRaw(userEvmAddress, mintHex);
    if (last > floor) return last - floor;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return last > floor ? last - floor : 0n;
}

/// Poll the Rome tx receipt (wagmi's watcher stalls on Rome — same
/// pattern as `use-ata-init`). Resolves success/reverted; throws on
/// timeout.
export async function waitForRomeReceipt(
  hash: Hex,
  opts?: { timeoutMs?: number },
): Promise<{ status: 'success' | 'reverted'; transactionHash: Hex }> {
  const timeoutMs = opts?.timeoutMs ?? 90_000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(ROME_RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [hash],
        }),
      });
      const json = await res.json();
      if (json.result?.blockNumber) {
        return {
          status: json.result.status === '0x1' ? 'success' : 'reverted',
          transactionHash: json.result.transactionHash as Hex,
        };
      }
    } catch {
      /* transient RPC hiccup — keep polling */
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`receipt poll timed out for ${hash}`);
}
