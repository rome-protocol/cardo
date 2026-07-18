// Deterministic compose — unhappy-path cases for the recipe engine.
//
// buildStepInvoke delegates to the proven Meteora / Mango builders, so
// these assert the WIRING: the shipping recipe (`swap-lend-mango`)
// assembles the same valid-but-reverting calldata the single-dapp
// screens do. A fresh user (no input ATA, no MangoAccount) trips the
// on-chain validators — exactly the boundary the /swap and /lend-mango
// cases pin.

import { buildStepInvoke, getRecipe, type ComposeContext } from '../../lib/compose/recipes';
import type { TestCaseFile } from '../lib/case';

const FRESH_USER_EVM = '0x000000000000000000000000000000000000d017' as const;

const recipe = getRecipe('swap-lend-mango')!;
const swapStep = recipe.steps.find((s) => s.kind === 'swap')!;
const depositStep = recipe.steps.find((s) => s.kind === 'mango-deposit')!;

// A representative mid-run context: 5 USDC in, 0.03 wSOL reconciled out.
const ctx: ComposeContext = {
  userEvmAddress: FRESH_USER_EVM,
  inputRaw: 5_000_000n, // 5 USDC (6dp)
  depositRaw: 30_000_000n, // 0.03 wSOL (9dp) — the reconciled deposit
  minimumOut: 1n,
  mangoAccountExists: false,
};

const cases: TestCaseFile = [
  {
    name: 'compose.swap-lend.swap-step.fresh-user-no-input-ata',
    description:
      'swap-lend-mango step 0 (Meteora USDC→wSOL) via buildStepInvoke, fresh user with no USDC ATA → strict-mode revert. Proves compose emits the same swap calldata /swap ships.',
    build: () => buildStepInvoke(swapStep, ctx)!,
    expect: { revertContains: 'Custom' },
  },
  {
    name: 'compose.swap-lend.deposit-step.fresh-user-no-mango-account',
    description:
      'swap-lend-mango step 2 (Mango token_deposit of the reconciled wSOL) via buildStepInvoke, fresh user with no MangoAccount → account-validator revert. Proves the deposit carries the right bank/vault/oracle + u64 amount.',
    build: () => buildStepInvoke(depositStep, ctx)!,
    expect: { revertContains: 'Custom' },
  },
];

export default cases;
