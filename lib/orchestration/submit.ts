// Submit an orchestrated bundle to a Jito-compatible block engine.
//
// Takes signed Solana transactions (one per Cardo "step"), wraps as a
// Jito bundle (≤5 txs), POSTs to the block-engine's /api/v1/bundles
// JSON-RPC endpoint, polls bundle status.
//
// Endpoint is configurable so the same code targets:
//   - Mainnet Jito:  https://mainnet.block-engine.jito.wtf/api/v1/bundles
//   - Testnet Jito:  https://testnet.block-engine.jito.wtf/api/v1/bundles
//   - a local block-engine stub (pass blockEngineUrl)

import type { Transaction, VersionedTransaction } from '@solana/web3.js';
import bs58Mod from 'bs58';
const b58 = (bs58Mod as { default?: typeof bs58Mod }).default ?? bs58Mod;

export type SubmitArgs = {
  /// Up to 5 signed txs (legacy or versioned).
  txs: (Transaction | VersionedTransaction)[];
  /// Jito-compatible block engine URL. Defaults to mainnet Jito; pass to override.
  blockEngineUrl?: string;
  /// Solana RPC fallback for landing checks when Jito poll is rate-limited.
  /// Defaults to mainnet-beta public RPC.
  solanaRpcUrl?: string;
  /// Poll timeout for getBundleStatuses.
  pollTimeoutMs?: number;
  /// Poll interval.
  pollIntervalMs?: number;
};

export type SubmitResult = {
  bundleId: string;
  submitMs: number;
  status: 'Confirmed' | 'Failed' | 'Pending' | 'Timeout';
  landMs?: number;
  slot?: number;
  err?: unknown;
};

const DEFAULT_ENDPOINT = 'https://mainnet.block-engine.jito.wtf/api/v1/bundles';

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  // Retry with backoff on rate-limit (-32097) — Jito mainnet endpoints throttle hard.
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 1000 * attempt));
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const j = (await res.json()) as { result?: T; error?: { code: number; message: string } };
    if (j.error) {
      lastErr = new Error(`${method} ${j.error.code}: ${j.error.message}`);
      // Retry on rate-limit / congestion
      if (j.error.code === -32097 || j.error.message.toLowerCase().includes('rate limit')) continue;
      throw lastErr;
    }
    return j.result as T;
  }
  throw lastErr ?? new Error(`${method}: exhausted retries`);
}

function serializeTx(tx: Transaction | VersionedTransaction): Uint8Array {
  // VersionedTransaction has serialize() returning Uint8Array; legacy returns Buffer.
  const out = (tx as { serialize: () => Uint8Array | Buffer }).serialize();
  return out instanceof Uint8Array ? out : new Uint8Array(out);
}

export async function submitBundle(args: SubmitArgs): Promise<SubmitResult> {
  const url = args.blockEngineUrl ?? DEFAULT_ENDPOINT;
  if (args.txs.length === 0) throw new Error('empty bundle');
  if (args.txs.length > 5) throw new Error('bundle exceeds 5-tx limit');

  const txsBs58 = args.txs.map((tx) => b58.encode(serializeTx(tx)));

  const t0 = Date.now();
  const bundleId = await rpc<string>(url, 'sendBundle', [txsBs58]);
  const submitMs = Date.now() - t0;

  const pollTimeout = args.pollTimeoutMs ?? 30_000;
  const pollInterval = args.pollIntervalMs ?? 500;

  const pollStart = Date.now();
  // Hybrid poll: try Jito getBundleStatuses, fall back to Solana RPC sig
  // status if Jito's poll endpoint is rate-limited (mainnet often is).
  const txSigs = args.txs.map(tx => b58.encode(serializeTx(tx))).map(s => {
    // Extract the first signature from the serialized tx (compactArray prefix + sig0).
    const raw = b58.decode(s);
    return b58.encode(raw.subarray(1, 65));
  });
  const solanaRpc = args.solanaRpcUrl ?? 'https://api.mainnet-beta.solana.com';

  while (Date.now() - pollStart < pollTimeout) {
    // First try Jito's bundle status endpoint
    type StatusValue = {
      bundle_id: string;
      transactions: string[];
      slot: number | null;
      confirmation_status: 'Confirmed' | 'Failed' | 'Pending';
      err: unknown;
    } | null;
    try {
      const r = await rpc<{ context: { slot: number }; value: StatusValue[] }>(
        url,
        'getBundleStatuses',
        [[bundleId]],
      );
      const v = r.value?.[0];
      if (v?.confirmation_status === 'Confirmed') {
        return { bundleId, submitMs, status: 'Confirmed', landMs: Date.now() - pollStart, slot: v.slot ?? undefined };
      }
      if (v?.confirmation_status === 'Failed') {
        return { bundleId, submitMs, status: 'Failed', landMs: Date.now() - pollStart, slot: v.slot ?? undefined, err: v.err };
      }
    } catch (_e) {
      // Jito poll failed (rate-limit etc.) — fall through to Solana RPC
    }

    // Fallback: poll Solana RPC for the first tx's status
    try {
      const r = await fetch(solanaRpc, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSignatureStatuses', params: [txSigs] }),
      });
      const j = await r.json() as { result?: { value: Array<{ slot: number; err: unknown; confirmationStatus: string } | null> } };
      const allLanded = j.result?.value?.every(s => s?.confirmationStatus);
      if (allLanded) {
        const anyFailed = j.result!.value.some(s => s?.err);
        return {
          bundleId,
          submitMs,
          status: anyFailed ? 'Failed' : 'Confirmed',
          landMs: Date.now() - pollStart,
          slot: j.result!.value[0]?.slot,
          err: anyFailed ? j.result!.value.find(s => s?.err)?.err : undefined,
        };
      }
    } catch (_e) { /* fall through */ }

    await new Promise(r => setTimeout(r, pollInterval));
  }
  return { bundleId, submitMs, status: 'Timeout', landMs: Date.now() - pollStart };
}
