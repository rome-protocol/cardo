// Deterministic compose — the in-house orchestrator.
//
// A *recipe* is an ordered list of *steps*, each of which reuses a
// PROVEN per-protocol invoke builder (the same ones the single-dapp
// screens ship). There is no AI here and no fake step: a recipe is a
// fixed, auditable plan, and every runnable step compiles to real Rome
// CPI calldata via `buildStepInvoke`.
//
// WHY sequential, not atomic. Rome's per-tx limits (1232-byte tx /
// 1.4M CU) mean a multi-protocol intent can't fold into one signature.
// A recipe therefore runs as N sequential Rome-CPI txs, each settling
// before the next — and the deposit amount is *reconciled* from the
// real post-swap balance rather than guessed from the swap input (see
// `depositRaw` below). Atomic all-or-nothing bundling (Jito) is a
// separate path, not wired here.
//
// Clean-chain fact (verified on-chain): the canonical Meteora pool's
// wSOL side (`So11…112`) is the SAME mint the Mango SOL bank takes, so
// the swap's output feeds the Mango deposit with no wrapper hop.

import type { Address, Hex } from 'viem';
import type { AccountMeta } from '../cpi-precompile';
import {
  buildChainMeteoraSwapInvoke,
  type SwapDirection,
} from '../meteora-swap';
import {
  buildMangoAccountCreateInvoke,
  buildMangoTokenDepositInvoke,
} from '../mango-instructions';
import { ROME_METEORA_POOL } from '../meteora-pool';
import { MANGO_SOL_BANK } from '../mango-config';

/// The DAMM v1 pool-constant shape (`ROME_METEORA_POOL` and its
/// fee-tier / LST siblings all conform).
type MeteoraPool = typeof ROME_METEORA_POOL;

// ─────────────────────────────────────────────────────────────────────
// Step + recipe model
// ─────────────────────────────────────────────────────────────────────

/// The runnable step kinds. Each maps to one proven invoke builder.
/// `preview` is a display-only row for a recipe whose venue is dead on
/// the current substrate — it never compiles to calldata.
export type ComposeStepKind =
  | 'swap'
  | 'mango-ensure-account'
  | 'mango-deposit'
  | 'preview';

type StepBase = {
  /// Stable id within the recipe (React key + per-step status map).
  id: string;
  /// Short imperative title, e.g. "Swap USDC → wSOL".
  title: string;
  /// Solana venue chip, e.g. "Meteora", "Mango".
  venue: string;
  /// One-line description of what the step does. No live numbers —
  /// real amounts are filled by the executor at run time.
  note: string;
};

export type ComposeStep =
  | (StepBase & {
      kind: 'swap';
      pool: MeteoraPool;
      /// Pool A/B direction for the trade (canonical pool: A=wSOL,
      /// B=USDC ⇒ USDC→wSOL is 'BToA').
      direction: SwapDirection;
      /// Pool fee tier in bps — feeds the constant-product quote that
      /// sets minimumOut (canonical USDC↔wSOL pool = 25).
      feeBps: number;
      inputToken: string;
      outputToken: string;
    })
  | (StepBase & {
      kind: 'mango-ensure-account';
      groupHex: Hex;
    })
  | (StepBase & {
      kind: 'mango-deposit';
      groupHex: Hex;
      mintHex: Hex;
      bank: { pubkey: Hex; vault: Hex; oracle: Hex };
      token: string;
    })
  | (StepBase & { kind: 'preview' });

export type ComposeRecipe = {
  /// Stable id (URL / status key).
  id: string;
  /// Card title.
  title: string;
  /// One-line summary shown under the title.
  summary: string;
  /// Runnable? A disabled recipe is an honest preview of a flow whose
  /// venue isn't usable on the devnet substrate.
  enabled: boolean;
  /// Why it's disabled (shown to the user). Present iff `!enabled`.
  disabledReason?: string;
  /// The token the user starts from.
  inputToken: string;
  inputDecimals: number;
  steps: ComposeStep[];
};

/// Everything `buildStepInvoke` needs to compile a step. `inputRaw`
/// drives the first (swap) step; `depositRaw` is the RECONCILED balance
/// (read from chain after the swap settles) that the deposit step uses
/// — never the swap input.
export type ComposeContext = {
  userEvmAddress: Address;
  inputRaw: bigint;
  depositRaw: bigint;
  minimumOut: bigint;
  mangoAccountExists: boolean;
};

/// A single Rome CPI invoke, ready for `writeContract({ args: [program,
/// accounts, data] })`. `addresses` carries derived PDAs when the
/// builder exposes them (Mango account / ATA), for the executor's use.
export type ComposeInvoke = {
  program: Hex;
  accounts: AccountMeta[];
  data: Hex;
  addresses?: Record<string, Hex>;
};

// ─────────────────────────────────────────────────────────────────────
// The one shipping recipe: swap USDC → wSOL, then lend it on Mango.
// ─────────────────────────────────────────────────────────────────────

const SWAP_LEND_MANGO: ComposeRecipe = {
  id: 'swap-lend-mango',
  title: 'Swap USDC → SOL, lend on Mango',
  summary:
    'Trade USDC for wSOL on Meteora, then deposit it to earn on Mango — one plan, run step by step.',
  enabled: true,
  inputToken: 'USDC',
  inputDecimals: 6,
  steps: [
    {
      kind: 'swap',
      id: 'swap',
      title: 'Swap USDC → wSOL',
      venue: 'Meteora',
      note: 'Trade your USDC for wSOL on the canonical 0.25% pool.',
      pool: ROME_METEORA_POOL,
      direction: 'BToA', // pool A=wSOL, B=USDC ⇒ USDC(B) → wSOL(A)
      feeBps: 25, // canonical 0.25% pool
      inputToken: 'USDC',
      outputToken: 'wSOL',
    },
    {
      kind: 'mango-ensure-account',
      id: 'mango-ensure-account',
      title: 'Open a Mango account',
      venue: 'Mango',
      note: 'Create your Mango account if you don’t have one yet — skipped if you already do.',
      groupHex: MANGO_SOL_BANK.groupHex,
    },
    {
      kind: 'mango-deposit',
      id: 'mango-deposit',
      title: 'Deposit wSOL to Mango',
      venue: 'Mango',
      note: 'Deposit the wSOL you just received into Mango’s SOL bank to start earning.',
      groupHex: MANGO_SOL_BANK.groupHex,
      mintHex: MANGO_SOL_BANK.mintHex,
      bank: {
        pubkey: MANGO_SOL_BANK.bankHex,
        vault: MANGO_SOL_BANK.vaultHex,
        oracle: MANGO_SOL_BANK.oracleHex,
      },
      token: 'wSOL',
    },
  ],
};

// ─────────────────────────────────────────────────────────────────────
// Disabled previews — honest rows for flows whose venues are dead on
// the devnet substrate (no perp venue; Kamino supply/borrow unwired).
// They render greyed-out and never build calldata.
// ─────────────────────────────────────────────────────────────────────

const preview = (id: string, title: string, venue: string, note: string): ComposeStep => ({
  kind: 'preview',
  id,
  title,
  venue,
  note,
});

const DISABLED_RECIPES: ComposeRecipe[] = [
  {
    id: 'perp-with-usdc',
    title: 'Open a SOL perp with USDC',
    summary: 'Swap USDC → SOL, post margin, open a SOL-PERP long.',
    enabled: false,
    disabledReason:
      'No perp venue runs on the devnet substrate. Live perps are in the Orchestrator.',
    inputToken: 'USDC',
    inputDecimals: 6,
    steps: [
      preview('swap', 'Swap USDC → SOL', 'Meteora', 'Trade USDC for wSOL.'),
      preview('margin', 'Post margin', 'Drift', 'Deposit wSOL as perp margin.'),
      preview('perp', 'Open SOL-PERP · long', 'Drift', 'Open a leveraged long position.'),
    ],
  },
  {
    id: 'lev-loop',
    title: 'Leveraged SOL lending loop',
    summary: 'Deposit SOL, borrow USDC, swap back to SOL, redeposit — 2× exposure.',
    enabled: false,
    disabledReason: 'Kamino supply/borrow isn’t wired on the devnet substrate.',
    inputToken: 'USDC',
    inputDecimals: 6,
    steps: [
      preview('dep', 'Deposit SOL', 'Kamino', 'Post wSOL as collateral.'),
      preview('brw', 'Borrow USDC', 'Kamino', 'Borrow against the collateral.'),
      preview('swp', 'Swap USDC → SOL', 'Meteora', 'Trade the borrowed USDC back to wSOL.'),
      preview('dep2', 'Redeposit SOL', 'Kamino', 'Add the wSOL back as collateral.'),
    ],
  },
  {
    id: 'yield-carry',
    title: 'USDC → mSOL → supply',
    summary: 'Swap stable for mSOL (staking yield), supply on Kamino to compound.',
    enabled: false,
    disabledReason: 'Kamino supply isn’t wired on the devnet substrate.',
    inputToken: 'USDC',
    inputDecimals: 6,
    steps: [
      preview('swp', 'Swap USDC → mSOL', 'Meteora', 'Trade USDC for mSOL.'),
      preview('dep', 'Supply mSOL', 'Kamino', 'Supply mSOL to a Kamino reserve.'),
    ],
  },
];

/// Every recipe Compose knows about — the enabled one first, then the
/// honest previews.
export const RECIPES: ComposeRecipe[] = [SWAP_LEND_MANGO, ...DISABLED_RECIPES];

export function getRecipe(id: string): ComposeRecipe | undefined {
  return RECIPES.find((r) => r.id === id);
}

// ─────────────────────────────────────────────────────────────────────
// Step → calldata
// ─────────────────────────────────────────────────────────────────────

/// Compile one recipe step to a Rome CPI invoke, or `null` when the
/// step is a no-op in this context:
///   - `mango-ensure-account` when the account already exists (skip)
///   - `preview` (dead-venue display row — never runnable)
///
/// Every runnable branch delegates to a proven single-dapp builder, so
/// the compose path can't drift from the screens it's assembled from.
export function buildStepInvoke(
  step: ComposeStep,
  ctx: ComposeContext,
): ComposeInvoke | null {
  switch (step.kind) {
    case 'swap':
      return buildChainMeteoraSwapInvoke({
        userEvmAddress: ctx.userEvmAddress,
        direction: step.direction,
        amountIn: ctx.inputRaw,
        minimumOut: ctx.minimumOut,
        pool: step.pool,
      });

    case 'mango-ensure-account':
      // Idempotent: only create when the user has no MangoAccount yet.
      if (ctx.mangoAccountExists) return null;
      return buildMangoAccountCreateInvoke({
        userEvmAddress: ctx.userEvmAddress,
        groupHex: step.groupHex,
        name: 'Cardo',
      });

    case 'mango-deposit':
      // Deposit the RECONCILED post-swap balance, never the swap input.
      return buildMangoTokenDepositInvoke({
        userEvmAddress: ctx.userEvmAddress,
        groupHex: step.groupHex,
        mintHex: step.mintHex,
        bank: step.bank,
        amount: ctx.depositRaw,
      });

    case 'preview':
      return null;
  }
}
