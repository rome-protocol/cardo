// Jupiter aggregator integration for the orchestrator.
//
// Jupiter routes across 100+ Solana DEXes and returns:
//   /quote → best output amount + route plan + price impact
//   /swap-instructions → pre-built setupInstructions + swapInstruction
//                       + cleanupInstruction + ALT addresses
//
// We use the lite-api endpoint (no auth required for reasonable volumes).
// In production Cardo, swap to dedicated infra at https://api.jup.ag.

import {
  PublicKey,
  TransactionInstruction,
  AddressLookupTableAccount,
  Connection,
} from '@solana/web3.js';

const JUPITER_HOST = process.env.JUPITER_HOST ?? 'https://lite-api.jup.ag';

export type JupQuote = {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string; // min-out at quoted slippage
  swapMode: 'ExactIn' | 'ExactOut';
  priceImpactPct: string;
  routePlan: Array<{
    swapInfo: { label: string; ammKey: string; inputMint: string; outputMint: string };
    percent: number;
  }>;
};

export async function jupQuote(args: {
  inputMint: string;
  outputMint: string;
  amount: bigint; // raw smallest units of inputMint (or outputMint if ExactOut)
  slippageBps: number;
  swapMode?: 'ExactIn' | 'ExactOut';
  onlyDirectRoutes?: boolean;
}): Promise<JupQuote> {
  const params = new URLSearchParams({
    inputMint: args.inputMint,
    outputMint: args.outputMint,
    amount: args.amount.toString(),
    slippageBps: args.slippageBps.toString(),
  });
  if (args.swapMode) params.set('swapMode', args.swapMode);
  if (args.onlyDirectRoutes) params.set('onlyDirectRoutes', 'true');
  const res = await fetch(`${JUPITER_HOST}/swap/v1/quote?${params}`);
  if (!res.ok) throw new Error(`Jupiter quote ${res.status}: ${await res.text().catch(()=>'')}`);
  return res.json() as Promise<JupQuote>;
}

export type JupSwapInstructions = {
  computeBudgetInstructions: ApiIx[];
  setupInstructions: ApiIx[];
  swapInstruction: ApiIx;
  cleanupInstruction: ApiIx | null;
  addressLookupTableAddresses: string[];
  computeUnitLimit?: number;
  prioritizationFeeLamports?: number;
};

type ApiIx = {
  programId: string;
  accounts: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  data: string; // base64
};

export async function jupSwapInstructions(args: {
  quote: JupQuote;
  userPublicKey: PublicKey;
  wrapAndUnwrapSol?: boolean;
  asLegacyTransaction?: boolean;
}): Promise<JupSwapInstructions> {
  const body = {
    quoteResponse: args.quote,
    userPublicKey: args.userPublicKey.toBase58(),
    wrapAndUnwrapSol: args.wrapAndUnwrapSol ?? true,
    asLegacyTransaction: args.asLegacyTransaction ?? false,
    // Let Jupiter size the compute unit limit based on the actual route —
    // setting it ourselves to 1.4M (the Solana max) was causing Phantom's
    // simulator to surface a misleading "not enough SOL" warning even
    // when the wallet had ample balance.
    dynamicComputeUnitLimit: true,
    // Jupiter's "auto" priority strategy picks a percentile-based fee
    // calibrated to current congestion. Cleaner than our static guess.
    prioritizationFeeLamports: 'auto',
  };
  const res = await fetch(`${JUPITER_HOST}/swap/v1/swap-instructions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Jupiter swap-ix ${res.status}: ${await res.text().catch(()=>'')}`);
  return res.json() as Promise<JupSwapInstructions>;
}

/// Convert Jupiter's API ix shape to TransactionInstruction.
export function apiIxToTransactionInstruction(ix: ApiIx): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map(a => ({
      pubkey: new PublicKey(a.pubkey),
      isSigner: a.isSigner,
      isWritable: a.isWritable,
    })),
    data: Buffer.from(ix.data, 'base64'),
  });
}

/// Fetch + materialize address lookup table accounts from a list of pubkeys.
export async function fetchAlts(
  conn: Connection,
  altAddresses: string[],
): Promise<AddressLookupTableAccount[]> {
  if (altAddresses.length === 0) return [];
  const out: AddressLookupTableAccount[] = [];
  for (const addr of altAddresses) {
    const r = await conn.getAddressLookupTable(new PublicKey(addr));
    if (r.value) out.push(r.value);
  }
  return out;
}

/// Convenience: produce all the TransactionInstructions Cardo needs to bundle.
export async function jupSwapForBundle(args: {
  conn: Connection;
  inputMint: string;
  outputMint: string;
  amount: bigint;
  slippageBps: number;
  user: PublicKey;
  wrapAndUnwrapSol?: boolean;
}): Promise<{
  quote: JupQuote;
  computeBudgetIxs: TransactionInstruction[];
  setupIxs: TransactionInstruction[];
  swapIx: TransactionInstruction;
  cleanupIx: TransactionInstruction | null;
  alts: AddressLookupTableAccount[];
  computeUnitLimit: number;
}> {
  const quote = await jupQuote({
    inputMint: args.inputMint,
    outputMint: args.outputMint,
    amount: args.amount,
    slippageBps: args.slippageBps,
  });
  const ixs = await jupSwapInstructions({
    quote,
    userPublicKey: args.user,
    wrapAndUnwrapSol: args.wrapAndUnwrapSol,
  });
  const alts = await fetchAlts(args.conn, ixs.addressLookupTableAddresses);
  return {
    quote,
    /// Jupiter's compute-budget ixs: setComputeUnitLimit + setComputeUnitPrice
    /// sized to the actual route. Caller should put these FIRST in the tx.
    computeBudgetIxs: ixs.computeBudgetInstructions.map(apiIxToTransactionInstruction),
    setupIxs: ixs.setupInstructions.map(apiIxToTransactionInstruction),
    swapIx: apiIxToTransactionInstruction(ixs.swapInstruction),
    cleanupIx: ixs.cleanupInstruction ? apiIxToTransactionInstruction(ixs.cleanupInstruction) : null,
    alts,
    computeUnitLimit: ixs.computeUnitLimit ?? 200_000,
  };
}
