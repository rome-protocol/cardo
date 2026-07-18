// Cardo orchestrator configuration.
//
// Single source of truth for fee rate + treasury destination. Both are
// env-overridable so we can tune in production without redeploying.
//
// Fee model: take-rate on every executed trade. We charge it on the
// OUTPUT side (post-DEX-execution, pre-user-receive) so the fee scales
// with what the user actually got, not what they intended to spend.
//
// Slippage stays user-controlled and is independent of this fee.

/// Cardo's take-rate fee, in basis points. Default 30 (= 0.30%).
/// Override via NEXT_PUBLIC_CARDO_FEE_BPS for client visibility, or
/// CARDO_FEE_BPS for server-only.
export const CARDO_FEE_BPS: number = (() => {
  const v =
    process.env.NEXT_PUBLIC_CARDO_FEE_BPS ?? process.env.CARDO_FEE_BPS ?? '30';
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : 30;
})();

/// Treasury Solana pubkey — receives the take-rate. Day-one wallet under
/// human control; rotates by changing the env (and migrating funds).
/// Generated 2026-04-28: <your-cardo-treasury-pubkey>
/// Private key kept at <your-secrets-dir>/cardo-treasury/treasury.key (not in repo).
export const CARDO_TREASURY_PUBKEY: string =
  process.env.NEXT_PUBLIC_CARDO_TREASURY_PUBKEY ??
  process.env.CARDO_TREASURY_PUBKEY ??
  '11111111111111111111111111111111';

/// Solana mainnet RPC endpoints used by the orchestrator backend.
///
/// Reads in priority order:
///   MAINNET_RPCS — comma-separated list (preferred). First entry is the
///                  primary; each is tried in order on failure.
///   MAINNET_RPC  — single-endpoint fallback (back-compat).
///   default      — Solana's public endpoint (heavily rate-limited).
///
/// In production we run dedicated Solana RPC endpoints. Setting the list
/// lets `withRpcFailover` cycle through them
/// transparently when one returns 429 / 502 / network error.
function loadRpcs(): string[] {
  const list = process.env.MAINNET_RPCS ?? process.env.MAINNET_RPC ?? '';
  const parsed = list
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : ['https://api.mainnet-beta.solana.com'];
}

export const MAINNET_RPCS: string[] = loadRpcs();
/// Back-compat: first endpoint, for code that still expects a single string.
export const MAINNET_RPC: string = MAINNET_RPCS[0];

/// Build a Connection that fails over per-RPC-call across all configured
/// endpoints. Wraps the two methods Cardo's quote layer actually uses
/// (getAccountInfo, getMultipleAccountsInfo) — extending to others is a
/// one-line addition to the WRAPPED set.
///
/// Why per-call (not per-analyze-call): the quote functions catch errors
/// internally and convert them to FailedQuote. That means analyze*Intent
/// returns [] on RPC failure rather than throwing — which a wrap-the-whole-
/// function failover can't observe. Per-call failover sees the error
/// directly at the RPC boundary where it actually occurs.
///
/// Connections are cached per URL so we don't pay setup cost on retries.
const _connCache = new Map<string, import('@solana/web3.js').Connection>();
async function getConn(url: string) {
  const cached = _connCache.get(url);
  if (cached) return cached;
  const { Connection } = await import('@solana/web3.js');
  const c = new Connection(url, 'confirmed');
  _connCache.set(url, c);
  return c;
}

const WRAPPED = new Set([
  'getAccountInfo',
  'getMultipleAccountsInfo',
  'getLatestBlockhash',
  'getAddressLookupTable',
  'getSignatureStatuses',
  'getSignaturesForAddress',
  'getTransaction',
  'getBalance',
  'sendRawTransaction',
  'confirmTransaction',
  'simulateTransaction',
]);

export async function makeFailoverConnection(): Promise<
  import('@solana/web3.js').Connection
> {
  const primary = await getConn(MAINNET_RPCS[0]);
  if (MAINNET_RPCS.length === 1) return primary;

  return new Proxy(primary, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && WRAPPED.has(prop)) {
        return async (...args: unknown[]) => {
          let lastErr: unknown;
          for (let i = 0; i < MAINNET_RPCS.length; i++) {
            const url = MAINNET_RPCS[i];
            try {
              const c = await getConn(url);
              const fn = (c as unknown as Record<string, (...a: unknown[]) => unknown>)[prop];
              return await (fn.apply(c, args) as Promise<unknown>);
            } catch (e) {
              lastErr = e;
              // eslint-disable-next-line no-console
              console.warn(
                `[orchestrate] RPC ${i + 1}/${MAINNET_RPCS.length} ${prop} on ${url} failed: ${
                  ((e as Error).message ?? String(e)).slice(0, 100)
                } — trying next`,
              );
            }
          }
          throw lastErr ?? new Error(`all RPCs failed for ${prop}`);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/// Convenience: run a function against a failover-aware Connection.
export async function withRpcFailover<T>(
  fn: (conn: import('@solana/web3.js').Connection) => Promise<T>,
): Promise<T> {
  const conn = await makeFailoverConnection();
  return fn(conn);
}

/// Apply Cardo's take-rate to a gross output amount (in any token's
/// smallest units). Returns the fee + user-receive amounts.
export function applyCardoFee(grossAmountOut: bigint): {
  feeAmount: bigint;
  userReceives: bigint;
  feeBps: number;
} {
  const feeBps = CARDO_FEE_BPS;
  const feeAmount = (grossAmountOut * BigInt(feeBps)) / 10000n;
  const userReceives = grossAmountOut - feeAmount;
  return { feeAmount, userReceives, feeBps };
}
