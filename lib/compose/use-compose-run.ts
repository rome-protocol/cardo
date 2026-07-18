'use client';
// useComposeRun — the deterministic compose executor.
//
// A recipe is N sequential Rome-CPI txs (Rome can't fold arbitrary
// multi-protocol writes into one signature). This hook runs them in
// order, one wallet signature per step, and — critically — RECONCILES
// between steps: after the swap settles it reads the real wSOL that
// arrived and deposits exactly that, never a guessed amount. Any step
// that reverts stops the run; earlier steps have already settled (this
// is not atomic, and the UI says so).
//
// Every write goes through useRomeWrite (auto chain-switch + estimate-
// first fees) → the CPI precompile. Every read goes through the plain
// 'confirmed' readers in ./reads. Every runnable step's calldata comes
// from buildStepInvoke → the same proven builders the screens ship.

import { useCallback, useMemo, useState } from 'react';
import { formatUnits, parseUnits, type Address, type Hex } from 'viem';
import { useRomeWrite } from '../use-rome-write';
import { useAtaInit } from '../use-ata-init';
import { useEnsurePdaLamports } from '../use-ensure-pda-lamports';
import { CPI_PRECOMPILE, CPI_INVOKE_ABI } from '../cpi-precompile';
import { fetchPoolReserves } from '../use-pool-reserves';
import { constantProductOut, applySlippage } from '../pool-quote';
import {
  bytes32ToPublicKey,
  deriveRomeUserPda,
  deriveUserAta,
} from '../solana-pda';
import { deriveMangoAccount } from '../mango-pdas';
import {
  buildStepInvoke,
  type ComposeContext,
  type ComposeRecipe,
} from './recipes';
import {
  readAccountExists,
  readAtaAmountRaw,
  reconcileAtaDelta,
  waitForRomeReceipt,
} from './reads';

/// Default slippage floor for the swap leg (1%). Compose isn't a trading
/// screen — it just needs the swap to execute near the quoted rate or
/// revert rather than dump at any price.
const DEFAULT_SLIPPAGE_BPS = 100;

export type StepPhase =
  | 'pending'
  | 'signing'
  | 'confirming'
  | 'reconciling'
  | 'skipped'
  | 'done'
  | 'failed';

export type StepRun = {
  id: string;
  title: string;
  venue: string;
  note: string;
  phase: StepPhase;
  hash?: Hex;
  /// Live one-liner filled as the step runs (real amounts, not a guess).
  detail?: string;
  error?: string;
};

export type ComposeRunState = {
  phase: 'idle' | 'running' | 'done' | 'failed';
  steps: StepRun[];
  activeIndex: number;
  error?: string;
};

function initialSteps(recipe: ComposeRecipe): StepRun[] {
  return recipe.steps.map((s) => ({
    id: s.id,
    title: s.title,
    venue: s.venue,
    note: s.note,
    phase: 'pending' as StepPhase,
  }));
}

/// Trim a raw token amount to a short human string (≤4 dp).
function fmtAmt(raw: bigint, decimals: number): string {
  const n = Number(formatUnits(raw, decimals));
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

export function useComposeRun(recipe: ComposeRecipe) {
  const { writeContractAsync } = useRomeWrite();
  const { init: ataInit } = useAtaInit();
  const { ensure: ensureLamports } = useEnsurePdaLamports();

  const [state, setState] = useState<ComposeRunState>(() => ({
    phase: 'idle',
    steps: initialSteps(recipe),
    activeIndex: -1,
  }));

  const reset = useCallback(() => {
    setState({ phase: 'idle', steps: initialSteps(recipe), activeIndex: -1 });
  }, [recipe]);

  const run = useCallback(
    async (userEvmAddress: Address, amountStr: string) => {
      if (!recipe.enabled) return;
      const amount = parseFloat(amountStr);
      if (!Number.isFinite(amount) || amount <= 0) return;

      const patch = (i: number, p: Partial<StepRun>) =>
        setState((s) => {
          const steps = s.steps.slice();
          steps[i] = { ...steps[i], ...p };
          return { ...s, steps };
        });

      // One signed CPI invoke → confirmed receipt. Throws on revert.
      const submit = async (i: number, program: Hex, accounts: unknown, data: Hex) => {
        patch(i, { phase: 'signing' });
        const hash = await writeContractAsync({
          address: CPI_PRECOMPILE,
          abi: CPI_INVOKE_ABI,
          functionName: 'invoke',
          // accounts is AccountMeta[]; the ABI validates the tuple shape.
          args: [program, accounts, data] as never,
        });
        patch(i, { phase: 'confirming', hash });
        const r = await waitForRomeReceipt(hash);
        if (r.status === 'reverted') throw new Error('reverted on-chain');
        return hash;
      };

      const user = userEvmAddress;
      const ctx: ComposeContext = {
        userEvmAddress: user,
        inputRaw: parseUnits(amountStr, recipe.inputDecimals),
        depositRaw: 0n,
        minimumOut: 0n,
        mangoAccountExists: false,
      };

      // The mint the swap outputs and the deposit consumes — same mint
      // (clean chain), read off the deposit step so nothing is hardcoded.
      const depositStep = recipe.steps.find((s) => s.kind === 'mango-deposit');
      const reconcileMint =
        depositStep && 'mintHex' in depositStep ? depositStep.mintHex : undefined;

      setState((s) => ({ ...s, phase: 'running', error: undefined }));

      for (let i = 0; i < recipe.steps.length; i++) {
        const step = recipe.steps[i];
        setState((s) => ({ ...s, activeIndex: i }));
        try {
          if (step.kind === 'swap') {
            // Pre-swap balance = reconcile floor.
            const floor = reconcileMint
              ? await readAtaAmountRaw(user, reconcileMint)
              : 0n;

            // Cold path: create the output-token ATA if it's missing, or
            // the swap reverts minting into a non-existent account.
            if (reconcileMint) {
              const outAta = bytes32ToPublicKey(
                deriveUserAta(user, reconcileMint),
              ).toBase58();
              if (!(await readAccountExists(outAta))) {
                patch(i, { phase: 'signing', detail: 'Creating your wSOL account…' });
                const ok = await ataInit({ userEvmAddress: user, mintHex: reconcileMint });
                if (!ok) throw new Error("couldn't create your wSOL receiving account");
              }
            }

            // minimumOut from the pool's live reserves (never an oracle).
            const { reserveA, reserveB } = await fetchPoolReserves(step.pool);
            if (reserveA == null || reserveB == null) {
              throw new Error('pool reserves unavailable — try again in a moment');
            }
            const [rIn, rOut] =
              step.direction === 'AToB' ? [reserveA, reserveB] : [reserveB, reserveA];
            const expOut = constantProductOut(rIn, rOut, ctx.inputRaw, step.feeBps);
            ctx.minimumOut = applySlippage(expOut, DEFAULT_SLIPPAGE_BPS);
            if (ctx.minimumOut <= 0n) {
              throw new Error('quote unavailable — reserves still loading');
            }

            const invoke = buildStepInvoke(step, ctx)!;
            patch(i, {
              detail: `${fmtAmt(ctx.inputRaw, recipe.inputDecimals)} ${step.inputToken} → ${step.outputToken}`,
            });
            const hash = await submit(i, invoke.program, invoke.accounts, invoke.data);

            // Reconcile: deposit exactly what arrived.
            patch(i, { phase: 'reconciling', hash, detail: 'Confirming what you received…' });
            const delta = reconcileMint
              ? await reconcileAtaDelta(user, reconcileMint, floor)
              : 0n;
            if (delta <= 0n) {
              throw new Error('swap settled but no wSOL arrived — stopping before deposit');
            }
            ctx.depositRaw = delta;
            patch(i, { phase: 'done', hash, detail: `Received ${fmtAmt(delta, 9)} wSOL` });
          } else if (step.kind === 'mango-ensure-account') {
            // Fresh 'confirmed' read so a stale plan can't double-create.
            const owner = deriveRomeUserPda(user);
            const mangoPda = bytes32ToPublicKey(
              deriveMangoAccount({ groupHex: step.groupHex, ownerHex: owner, accountNum: 0 }),
            ).toBase58();
            ctx.mangoAccountExists = await readAccountExists(mangoPda);

            const invoke = buildStepInvoke(step, ctx);
            if (!invoke) {
              patch(i, { phase: 'skipped', detail: 'You already have a Mango account' });
              continue;
            }
            // The MangoAccount rent (~0.06 SOL) is paid by the user's PDA;
            // a fresh PDA holds 0 → account_create reverts Custom(1). Fund
            // it first as a separate persisting tx (the same helper
            // /lend-mango uses), then create.
            patch(i, { phase: 'signing', detail: 'Funding your account for rent…' });
            const funded = await ensureLamports(user, {
              minLamports: 80_000_000n,
              reserveLamports: 80_000_000n,
            });
            if (funded !== 'ready') {
              throw new Error("couldn't fund your account for the Mango rent deposit");
            }
            const hash = await submit(i, invoke.program, invoke.accounts, invoke.data);
            ctx.mangoAccountExists = true;
            patch(i, { phase: 'done', hash, detail: 'Mango account created' });
          } else if (step.kind === 'mango-deposit') {
            if (ctx.depositRaw <= 0n) {
              throw new Error('nothing to deposit — reconcile produced 0');
            }
            const invoke = buildStepInvoke(step, ctx)!;
            const hash = await submit(i, invoke.program, invoke.accounts, invoke.data);
            patch(i, {
              phase: 'done',
              hash,
              detail: `Deposited ${fmtAmt(ctx.depositRaw, 9)} wSOL to Mango`,
            });
          } else {
            // preview — never runnable
            patch(i, { phase: 'skipped' });
          }
        } catch (e) {
          const msg = (e as Error)?.message ?? String(e);
          patch(i, { phase: 'failed', error: msg });
          setState((s) => ({ ...s, phase: 'failed', error: msg }));
          return;
        }
      }

      setState((s) => ({ ...s, phase: 'done', activeIndex: -1 }));
    },
    [recipe, writeContractAsync, ataInit, ensureLamports],
  );

  const busy = state.phase === 'running';
  const stepsForDisplay = useMemo(() => state.steps, [state.steps]);

  return { state, run, reset, busy, steps: stepsForDisplay };
}
