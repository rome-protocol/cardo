// Cardo unhappy-path test runner.
//
// Usage:
//   npx tsx tests/runner.ts                       # run all
//   npx tsx tests/runner.ts --filter=drift        # only cases whose name starts "drift."
//   npx tsx tests/runner.ts --filter=streamflow,orca   # multiple, comma-separated
//   npx tsx tests/runner.ts --bail                # stop on first failure
//   npx tsx tests/runner.ts --verbose             # print full revert + log dump
//
// Or via package.json:
//   npm run test:integrations -- --filter=drift
//
// Pre-flight:
//   1. ~/.cardo-test-treasury.key must exist (chmod 600). On first run
//      the harness prints a fresh key + a hint to fund it.
//   2. The treasury address needs ≥ 0.005 mETH on Rome (chainId
//      200010). Emulation doesn't consume gas but the proxy still
//      validates `gas_price * gas_limit ≤ balance`.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getTreasuryAccount } from './lib/treasury';
import { emulateInvoke, emulateRaw } from './lib/emulate';
import type { TestCase } from './lib/case';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CASES_DIR = path.join(__dirname, 'cases');

type Args = {
  filters: string[]; // empty = all
  bail: boolean;
  verbose: boolean;
};

function parseArgs(argv: string[]): Args {
  const out: Args = { filters: [], bail: false, verbose: false };
  for (const a of argv) {
    if (a === '--bail') out.bail = true;
    else if (a === '--verbose' || a === '-v') out.verbose = true;
    else {
      const m = a.match(/^--filter=(.+)$/);
      if (m) out.filters = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    }
  }
  return out;
}

async function loadAllCases(): Promise<TestCase[]> {
  if (!fs.existsSync(CASES_DIR)) return [];
  const entries = fs.readdirSync(CASES_DIR);
  const tsFiles = entries.filter((e) => e.endsWith('.ts'));
  const all: TestCase[] = [];
  for (const f of tsFiles) {
    const fullPath = path.join(CASES_DIR, f);
    // Dynamic import — tsx resolves .ts at runtime.
    const mod = (await import(fullPath)) as { default?: TestCase[] };
    if (!mod.default || !Array.isArray(mod.default)) {
      console.warn(`[runner] ${f}: no default-exported TestCase[]; skipping`);
      continue;
    }
    all.push(...mod.default);
  }
  return all;
}

function matchesFilter(name: string, filters: string[]): boolean {
  if (filters.length === 0) return true;
  return filters.some((f) => name.startsWith(`${f}.`) || name === f);
}

function summarizeReason(reason: string, max = 240): string {
  return reason.length <= max ? reason : `${reason.slice(0, max)}…`;
}

const COLORS = {
  reset: '[0m',
  green: '[32m',
  red: '[31m',
  yellow: '[33m',
  dim: '[2m',
} as const;

function fmt(color: keyof typeof COLORS, s: string) {
  if (!process.stdout.isTTY) return s;
  return `${COLORS[color]}${s}${COLORS.reset}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log(fmt('dim', 'cardo unhappy-path harness'));
  console.log(
    fmt('dim', `  filters: ${args.filters.length ? args.filters.join(', ') : '(all)'}`),
  );

  // Treasury setup. Side effect: prints a clear hint + exits if key
  // is missing or unfunded.
  const { account, pk } = await getTreasuryAccount();
  console.log(fmt('dim', `  signer:  ${account.address}`));

  const all = await loadAllCases();
  const cases = all.filter((c) => matchesFilter(c.name, args.filters));
  console.log(fmt('dim', `  cases:   ${cases.length}/${all.length}`));
  console.log();

  let pass = 0;
  let fail = 0;
  const failures: { case: TestCase; reason: string; expected: string }[] = [];

  for (const tc of cases) {
    process.stdout.write(`  ${tc.name} … `);
    let built: { kind: 'invoke'; invoke: ReturnType<NonNullable<TestCase['build']>> }
      | { kind: 'raw'; raw: ReturnType<NonNullable<TestCase['buildRaw']>> };
    try {
      if (tc.buildRaw) built = { kind: 'raw', raw: tc.buildRaw() };
      else if (tc.build) built = { kind: 'invoke', invoke: tc.build() };
      else throw new Error('case has neither build() nor buildRaw()');
    } catch (e) {
      console.log(fmt('red', 'BUILD ERROR'));
      console.log('    ' + (e instanceof Error ? e.message : String(e)));
      fail++;
      if (args.bail) break;
      continue;
    }

    const onTransportError = (e: unknown) => ({
      status: 'failed' as const,
      revertReason: `transport error: ${e instanceof Error ? e.message : String(e)}`,
      logs: [] as string[],
      raw: null,
    });
    const outcome =
      built.kind === 'raw'
        ? await emulateRaw({
            pk: tc.signerPk ?? pk,
            to: built.raw.to,
            data: built.raw.data,
            gasLimit: tc.gasLimit,
          }).catch(onTransportError)
        : await emulateInvoke({
            pk: tc.signerPk ?? pk,
            invoke: built.invoke,
            gasLimit: tc.gasLimit,
          }).catch(onTransportError);

    if ('success' in tc.expect && tc.expect.success) {
      if (outcome.status === 'success') {
        console.log(fmt('green', 'PASS'));
        pass++;
      } else {
        console.log(fmt('red', 'FAIL') + ' (expected success, got revert)');
        console.log(`    revert: ${summarizeReason(outcome.revertReason)}`);
        fail++;
        failures.push({ case: tc, reason: outcome.revertReason, expected: 'success' });
        if (args.bail) break;
      }
      continue;
    }

    const expected = (tc.expect as { revertContains: string }).revertContains;
    const expectedLc = expected.toLowerCase();

    if (outcome.status === 'success') {
      console.log(fmt('red', 'FAIL') + ' (no revert, expected to fail)');
      console.log(`    expected: revertContains "${expected}"`);
      fail++;
      failures.push({ case: tc, reason: '<no revert>', expected });
      if (args.bail) break;
      continue;
    }

    const haystack = [outcome.revertReason, ...outcome.logs].join('\n').toLowerCase();
    if (haystack.includes(expectedLc)) {
      console.log(fmt('green', 'PASS') + fmt('dim', ` — matched "${expected}"`));
      if (args.verbose) {
        console.log(fmt('dim', `    revert: ${summarizeReason(outcome.revertReason, 1000)}`));
      }
      pass++;
    } else {
      console.log(fmt('red', 'FAIL'));
      console.log(`    expected: revertContains "${expected}"`);
      console.log(`    actual:   ${summarizeReason(outcome.revertReason)}`);
      if (outcome.logs.length && args.verbose) {
        console.log('    logs:');
        for (const l of outcome.logs.slice(-5)) console.log('      ' + l);
      }
      fail++;
      failures.push({ case: tc, reason: outcome.revertReason, expected });
      if (args.bail) break;
    }
  }

  console.log();
  if (fail === 0) {
    console.log(fmt('green', `${pass} passed / 0 failed`));
    process.exit(0);
  } else {
    console.log(fmt('red', `${pass} passed / ${fail} failed`));
    if (!args.verbose) {
      console.log(fmt('dim', '  rerun with --verbose for full revert + log dumps'));
    }
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
