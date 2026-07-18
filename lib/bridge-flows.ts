// Pure bridge-flow logic (no react, no wagmi) — the send hooks are thin wallet
// glue over these. Three rules live here so tests can pin them hermetically:
//
// 1. Quote requests: per-flow builders; calldata NEVER built locally — it comes
//    from the quote (§7.4 equality verification kills local builders).
// 2. Signing: userSignedTxs() extracts the quote's user-signed txs verbatim, in
//    step order. step1BindingTxIndex() picks the tx whose hash registers the
//    transfer — the pod verifies step1TxHash against the LAST unsignedTx of
//    step 1 (CCTP-in [approve, depositForBurn] → the burn).
// 3. Status: transferFlowStatus() maps a TransferRecord to the exact strings
//    components/screens/Bridge.jsx humanPhase/humanOutcome render.
import type { Quote, QuoteRequest, TransferRecord, UnsignedTx } from './bridge-api-client';

export class BridgeFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BridgeFlowError';
  }
}

// ── Quote-request builders ───────────────────────────────────────────────────

export function inboundCctpQuoteRequest(p: {
  sourceChainId: number;
  romeChainId: number | string;
  amount: bigint;
  evmAddress: string;
  speed?: 'standard' | 'fast';
}): QuoteRequest {
  return {
    asset: 'USDC',
    direction: 'to-rome',
    sourceChain: 'ethereum',
    sourceChainId: p.sourceChainId,
    romeChainId: String(p.romeChainId),
    // Gas intent preserves today's behavior (Hadrian settles USDC as native
    // gas); the quote then carries the EIP-712 settle authorization to sign.
    intent: 'gas',
    ...(p.speed !== undefined ? { speed: p.speed } : {}),
    amount: p.amount.toString(),
    sender: { ethereum: p.evmAddress },
    recipient: p.evmAddress,
  };
}

export function inboundWhQuoteRequest(p: {
  sourceChainId: number;
  romeChainId: number | string;
  amount: bigint;
  evmAddress: string;
}): QuoteRequest {
  return {
    asset: 'ETH',
    direction: 'to-rome',
    sourceChain: 'ethereum',
    sourceChainId: p.sourceChainId,
    romeChainId: String(p.romeChainId),
    amount: p.amount.toString(),
    // EVM-only sender: the pod derives the Solana destination from `recipient`
    // and sponsors the completion leg (no sender.solana needed).
    sender: { ethereum: p.evmAddress },
    recipient: p.evmAddress,
  };
}

export function outboundCctpQuoteRequest(p: {
  destinationChainId: number;
  romeChainId: number | string;
  amount: bigint;
  evmAddress: string;
  recipient: string;
}): QuoteRequest {
  return {
    asset: 'USDC',
    direction: 'from-rome',
    // "ethereum" names the CCTP transport family for from-rome; the actual
    // destination goes in destinationChainId.
    sourceChain: 'ethereum',
    destinationChainId: p.destinationChainId,
    romeChainId: String(p.romeChainId),
    amount: p.amount.toString(),
    sender: { rome: p.evmAddress },
    recipient: p.recipient,
  };
}

export function outboundWhQuoteRequest(p: {
  romeChainId: number | string;
  amount: bigint;
  evmAddress: string;
  recipient: string;
}): QuoteRequest {
  return {
    asset: 'ETH',
    direction: 'from-rome',
    sourceChain: 'ethereum',
    romeChainId: String(p.romeChainId),
    amount: p.amount.toString(),
    sender: { rome: p.evmAddress },
    recipient: p.recipient,
  };
}

// ── User-signed tx extraction ────────────────────────────────────────────────

export interface UserSignedTx {
  stepN: number;
  tx: UnsignedTx;
}

/**
 * The txs the USER signs, verbatim from the quote, ordered by step. Sponsor
 * steps (unsignedTx: null / no unsignedTxs) are skipped. Route is asserted so
 * a surprising quote can never put the wallet on the wrong flow.
 */
export function userSignedTxs(quote: Quote, expectedRoute: string): UserSignedTx[] {
  if (quote.route !== expectedRoute) {
    throw new BridgeFlowError(`quote route ${quote.route} != expected ${expectedRoute}`);
  }
  const out: UserSignedTx[] = [];
  for (const step of [...quote.steps].sort((a, b) => a.n - b.n)) {
    if (!step.unsignedTxs?.length) continue;
    for (const tx of step.unsignedTxs) out.push({ stepN: step.n, tx });
  }
  if (out.length === 0) {
    throw new BridgeFlowError(`quote for ${expectedRoute} carries no user-signed txs`);
  }
  return out;
}

/**
 * Index (into userSignedTxs' result) of the tx whose hash is step1TxHash at
 * registration: the LAST tx of the FIRST step — the pod's §7.4 check verifies
 * against the last unsignedTx of quote.steps[0].
 */
export function step1BindingTxIndex(items: UserSignedTx[]): number {
  const firstStep = items[0]!.stepN;
  let idx = 0;
  for (let i = 0; i < items.length; i++) {
    if (items[i]!.stepN === firstStep) idx = i;
  }
  return idx;
}

// ── TransferRecord → screen status ───────────────────────────────────────────

export interface FlowStatus {
  /** humanPhase() input: registered | awaiting-attestation | awaiting-vaa | submitting | complete | failed */
  phase: string;
  /** humanOutcome() input, only on complete: all-gas | wrapper-only | settle-skipped */
  outcome?: string;
}

export function transferFlowStatus(record: TransferRecord): FlowStatus {
  const steps = record.steps ?? [];
  if (record.outcome === 'failed' || steps.some((s) => s.status === 'failed')) {
    return { phase: 'failed' };
  }
  if (record.outcome === 'complete') {
    if (record.degradation === 'settle-skipped') return { phase: 'complete', outcome: 'settle-skipped' };
    const settle = steps.find((s) => s.kind === 'settle-inbound-bridge-sponsored');
    if (settle && settle.status === 'confirmed' && !settle.skipped) return { phase: 'complete', outcome: 'all-gas' };
    return { phase: 'complete', outcome: 'wrapper-only' };
  }
  // In progress: a sponsor step past its attestation gate means the pod is
  // actively crediting; otherwise name what we're waiting on.
  if (steps.some((s) => s.status === 'ready' || (s.status === 'submitted' && s.n !== 1))) {
    return { phase: 'submitting' };
  }
  const blockers = steps.filter((s) => s.status === 'blocked').flatMap((s) => s.blockedBy ?? []);
  if (blockers.includes('circle-attestation')) return { phase: 'awaiting-attestation' };
  if (blockers.includes('wormhole-vaa')) return { phase: 'awaiting-vaa' };
  return { phase: 'registered' };
}
