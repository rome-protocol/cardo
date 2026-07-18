// Typed browser-direct client for the Rome bridge-api pod (/v1) — Phase A of
// the bridge-V1 retirement: Cardo stops proxying through the Rome web app's backend and
// talks to the pod that owns bridging (CORS *, no key).
//
// The load-bearing contract (bridge-api spec §7.4, equality-only verification):
// clients sign the QUOTE'S unsignedTxs VERBATIM — never locally-built calldata —
// and submit the quote object back UNMODIFIED. For the trustless gas settle the
// wallet signs a filled COPY of the quote's EIP-712 SettleAuthorization
// (sourceTxHash = the burn tx); the pod overlays the hash itself at verify time,
// so the quote stays pristine. domain.chainId stays NUMERIC over JSON — a string
// yields a different domain separator and SignerNotUser on-chain.
//
// Base URL: cardo is ONE chain-agnostic image — no NEXT_PUBLIC_* inlining. The
// runtime base rides /api/env (container env BRIDGE_API_BASE) and callers pass
// it per call ({ base }); the default is the devnet pod.

export const DEFAULT_BRIDGE_API_BASE = 'https://bridge-api.devnet.romeprotocol.xyz';

export interface BridgeApiOpts {
  /** Runtime base URL override (from /api/env). Defaults to the devnet pod. */
  base?: string;
}

// ── Wire types (mirror rome-bridge-api src/routes/{quote,transfers}.ts) ──────

export interface QuoteRequest {
  asset: 'USDC' | 'ETH' | 'SOL' | 'SPL' | 'TOKEN';
  splAsset?: { mint: string; decimals: number; symbol?: string; wrapper?: string };
  direction: 'to-rome' | 'from-rome';
  /** Legacy symbolic rail ("ethereum") or CAIP-2 ("eip155:11155111"). */
  sourceChain: string;
  sourceChainId?: number;
  destinationChainId?: number;
  speed?: 'standard' | 'fast';
  simulate?: boolean;
  deadlineSec?: number;
  romeChainId: string;
  intent?: 'gas' | 'wrapper';
  /** Base units, decimal string. */
  amount: string;
  sender: { ethereum?: string; solana?: string; rome?: string };
  recipient: string;
}

export interface UnsignedTx {
  to: `0x${string}`;
  data: `0x${string}`;
  value?: string;
  estimatedGas?: string;
  description?: string;
  simulation?: { ok: boolean; revertReason?: string };
}

export interface QuoteStep {
  n: number;
  chain: string;
  kind: string;
  /** Present on user-signed steps — sign these VERBATIM (§7.4). */
  unsignedTxs?: UnsignedTx[];
  unsignedTx?: null;
  blockedBy?: string[];
  userSigns?: boolean;
  sponsor?: 'user' | 'rome' | 'partner';
  chainRef?: string;
  chainName?: string;
  recipientAta?: string;
  recipientPdaOwner?: string;
  /** Settle step only: the Rome recipient the authorization must recover to. */
  user?: string;
}

export interface SettleTypedData {
  domain: { name: string; version: string; chainId: number; [k: string]: unknown };
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, string>;
}

export interface SettleSignatureRequest {
  kind: 'settle-authorization-eip712';
  /** Which message field the client fills from the burn tx hash. */
  fillFromBurn: 'sourceTxHash';
  typedData: SettleTypedData;
}

export interface Quote {
  route: string;
  direction: 'to-rome' | 'from-rome';
  amountIn: string;
  amountOut: string;
  fee?: { bps: number; absolute: string; asset: string };
  etaSeconds?: number;
  steps: QuoteStep[];
  signatureRequests?: SettleSignatureRequest[];
  outputs?: Array<{ kind: string; chainId?: string }>;
  cctpVersion?: number;
  sourceChainId?: number;
  sourceChainRef?: string;
  [k: string]: unknown;
}

export type TransferStepStatus = 'blocked' | 'ready' | 'submitted' | 'confirmed' | 'failed';

export interface TransferStep extends Omit<QuoteStep, 'unsignedTxs' | 'unsignedTx'> {
  status: TransferStepStatus;
  txHashes?: string[];
  skipped?: boolean;
  attestation?: unknown;
  vaa?: unknown;
  confirmedAt?: string;
}

export interface TransferRecord {
  id: string;
  route: string;
  direction: 'to-rome' | 'from-rome';
  amountIn: string;
  amountOut: string;
  sender: { ethereum?: string; solana?: string; rome?: string };
  recipient: string;
  steps: TransferStep[];
  outcome: 'pending' | 'complete' | 'failed';
  degradation?: string;
  degradationReason?: string;
  settleAuthorized?: boolean;
  [k: string]: unknown;
}

// ── Errors ───────────────────────────────────────────────────────────────────

/** Pod errors are problem+json: {code, title, status, detail}. */
export class BridgeApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail?: string;
  constructor(p: { code: string; status: number; title?: string; detail?: string }) {
    super(p.detail ?? p.title ?? p.code);
    this.name = 'BridgeApiError';
    this.code = p.code;
    this.status = p.status;
    if (p.detail !== undefined) this.detail = p.detail;
  }
}

async function request<T>(path: string, init?: RequestInit, opts?: BridgeApiOpts): Promise<T> {
  const res = await fetch(`${opts?.base ?? DEFAULT_BRIDGE_API_BASE}${path}`, { cache: 'no-store', ...init });
  if (res.ok) return (await res.json()) as T;
  let problem: { code?: string; title?: string; detail?: string } | null = null;
  try {
    problem = await res.json();
  } catch {
    /* non-JSON failure body (gateway/proxy) — fall through to the generic code */
  }
  throw new BridgeApiError({
    code: typeof problem?.code === 'string' ? problem.code : 'rome.bridge.http-error',
    status: res.status,
    ...(problem?.title !== undefined ? { title: problem.title } : {}),
    ...(problem?.detail !== undefined ? { detail: problem.detail } : {}),
  });
}

function postJson<T>(path: string, body: unknown, opts?: BridgeApiOpts): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, opts);
}

// ── The four /v1 calls ───────────────────────────────────────────────────────

export function requestQuote(req: QuoteRequest, opts?: BridgeApiOpts): Promise<Quote> {
  return postJson<Quote>('/v1/quote', req, opts);
}

/**
 * Register the transfer AFTER the source tx is broadcast. `quote` must be the
 * object /v1/quote returned, verbatim; `userSettleSig` only on gas-intent CCTP
 * inbound (absent = wormhole / wrapper / outbound).
 */
export function registerTransfer(p: { quote: Quote; step1TxHash: string; userSettleSig?: string }, opts?: BridgeApiOpts): Promise<TransferRecord> {
  return postJson<TransferRecord>('/v1/transfers', {
    quote: p.quote,
    step1TxHash: p.step1TxHash,
    ...(p.userSettleSig !== undefined ? { userSettleSig: p.userSettleSig } : {}),
  }, opts);
}

export function getTransfer(id: string, opts?: BridgeApiOpts): Promise<TransferRecord> {
  return request<TransferRecord>(`/v1/transfers/${encodeURIComponent(id)}`, undefined, opts);
}

/** Report a user-executed step tx (e.g. the outbound destination claim). */
export function reportStep(id: string, n: number, txHash: string, opts?: BridgeApiOpts): Promise<TransferRecord> {
  return postJson<TransferRecord>(`/v1/transfers/${encodeURIComponent(id)}/steps/${n}`, { txHash }, opts);
}

// ── Settle-authorization helper ──────────────────────────────────────────────

/**
 * The typed-data the wallet signs for the trustless gas settle: the quote's
 * SettleAuthorization with the burn tx hash filled into message.sourceTxHash.
 * Returns a COPY — the quote object stays pristine for registerTransfer.
 * Null when the quote carries no settle authorization (wormhole inbound,
 * wrapper intent, outbound).
 */
export function settleTypedDataWithBurn(quote: Quote, burnTxHash: string): SettleTypedData | null {
  const req = quote.signatureRequests?.[0];
  if (!req?.typedData) return null;
  const fillField = req.fillFromBurn ?? 'sourceTxHash';
  return {
    ...req.typedData,
    message: { ...req.typedData.message, [fillField]: burnTxHash },
  };
}
