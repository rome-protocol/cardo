// Orchestration types — Cardo's flagship product.
//
// Mental model:
//   1. User expresses an Intent (e.g., "swap N USDC → SOL with min slippage")
//   2. Orchestrator gets a Quote per available route (Orca, Raydium, Phoenix, …)
//   3. Picker selects the best Route given the user's preferences
//   4. Builder turns the chosen Route into a bundle of CPI ix
//   5. Submitter sends the bundle (≤5 txs) atomically via Jito-compatible endpoint
//
// All quotes are pure pool-state reads — no on-chain probes. This means the
// orchestrator can compute many quotes in parallel for cheap (one RPC roundtrip
// per pool, often batched).

import type { Address, Hex } from 'viem';

/// Where the swap can be routed.
export type Venue =
  | 'orca-whirlpool'
  | 'raydium-amm-v4'
  | 'raydium-cpmm'
  | 'meteora-damm-v1'
  | 'meteora-damm-v2'
  | 'meteora-dlmm'
  | 'phoenix-clob'
  | 'pumpswap'
  | 'pump-fun';

/// The user's intent. Today: simple swap A → B. Future: lend / borrow / compose.
export type SwapIntent = {
  kind: 'swap';
  /// User's EVM address (Cardo signs as their Rome PDA).
  userEvmAddress: Address;
  /// Solana SPL mint to spend (input side).
  inputMint: Hex;
  /// Solana SPL mint to receive (output side).
  outputMint: Hex;
  /// Amount in input mint smallest units.
  amountIn: bigint;
  /// Slippage tolerance in basis points (10_000 = 100%).
  /// e.g., 50 = 0.50% max slippage.
  slippageBps: number;
};

export type Intent = SwapIntent;

/// What a quote tells us about a single venue's path.
export type Quote = {
  venue: Venue;
  /// The on-chain pool/market address quoted against.
  poolAddress: Hex;
  /// Best-available output amount for the given input. Pre-fee, pre-slippage.
  amountOut: bigint;
  /// Effective price (output per unit input) in floating point for display.
  spotPrice: number;
  /// Estimated price impact bps for this trade size (0 = no impact estimate).
  priceImpactBps: number;
  /// Compute units this venue typically costs at trade time (rough estimate).
  estimatedCu: number;
  /// Free-form note for diagnostics ("pool too thin", "tick array missing", etc.).
  note?: string;
};

export type FailedQuote = {
  venue: Venue;
  poolAddress?: Hex;
  error: string;
};

/// Result of the picker.
export type Route = {
  intent: Intent;
  /// The winning quote.
  best: Quote;
  /// Other quotes for transparency / diagnostics.
  alternates: Quote[];
  /// Quotes that failed (and why) for diagnostics.
  failed: FailedQuote[];
};

/// CPI instruction triple shape Cardo's adapters produce. Builder converts
/// a Route into a list of these (one per Solana ix in the bundle).
export type CpiInvoke = {
  program: Hex;
  accounts: { pubkey: Hex; is_signer: boolean; is_writable: boolean }[];
  data: Hex;
};
