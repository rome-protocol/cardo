// Generates lib/chain-config.generated.json — Cardo's compiled chain set —
// from the installed @rome-protocol/registry pin (the aerarium pattern).
// Adding/removing a Rome chain is a registry change + `npm run build:chain-config`,
// never a code edit here.
//
// Inclusion rules:
//   - network `devnet` | `testnet` (mainnet is a deliberate future flip when
//     Cardo targets a mainnet chain, not an oversight; real-testnet is retired)
//   - status != 'retired' (a taken-down chain drops out on the next regen)
//   - the chain must survive lib/chain-resolve.ts `resolve()`:
//       status 'live'  + resolve failure → HARD ERROR (registry invariant broken)
//       other statuses + resolve failure → skipped with a warning (mid-bring-up
//                                          chains may not have wrappers yet)
//
// Runs first in `npm run build` (so the Docker image regenerates from its
// registry pin) and standalone via `npm run build:chain-config`. The output is
// COMMITTED; tests/chain-config-generated.test.ts fails when the committed
// file drifts from the installed pin.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  resolve as resolveChain,
  type GeneratedChainEntry,
  type RegistryBridge,
  type RegistryChain,
  type RegistryContract,
  type RegistryOracle,
  type RegistryToken,
} from '../lib/chain-resolve';

const INCLUDED_NETWORKS = new Set(['devnet', 'testnet']);

function registryRoot(): string {
  const root =
    process.env.ROME_REGISTRY_ROOT ??
    path.join(process.cwd(), 'node_modules', '@rome-protocol', 'registry');
  if (!existsSync(path.join(root, 'chains'))) {
    throw new Error(
      `build-chain-config: no registry chains/ at ${root} — ` +
        `npm install first, or point ROME_REGISTRY_ROOT at a registry checkout`,
    );
  }
  return root;
}

function readJson(p: string): unknown {
  return JSON.parse(readFileSync(p, 'utf8'));
}

export function generate(root: string = registryRoot()): GeneratedChainEntry[] {
  const chainsDir = path.join(root, 'chains');
  const entries: GeneratedChainEntry[] = [];
  for (const slug of readdirSync(chainsDir).sort()) {
    const dir = path.join(chainsDir, slug);
    const chainPath = path.join(dir, 'chain.json');
    if (!/^\d+-/.test(slug) || !existsSync(chainPath)) continue;
    const chain = readJson(chainPath) as RegistryChain;
    if (!INCLUDED_NETWORKS.has(chain.network) || chain.status === 'retired') continue;
    try {
      const tokens = readJson(path.join(dir, 'tokens.json')) as RegistryToken[];
      const contracts = readJson(path.join(dir, 'contracts.json')) as RegistryContract[];
      const oracle = readJson(path.join(dir, 'oracle.json')) as RegistryOracle;
      const bridgePath = path.join(dir, 'bridge.json');
      const bridge = existsSync(bridgePath) ? (readJson(bridgePath) as RegistryBridge) : null;
      resolveChain(chain, tokens, contracts, oracle, bridge ?? undefined); // validate — throws on gaps
      entries.push({ slug, chain, tokens, contracts, oracle, bridge });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (chain.status === 'live') {
        throw new Error(`build-chain-config: live chain ${slug} failed to resolve: ${msg}`);
      }
      console.warn(`build-chain-config: skipping ${slug} (status=${chain.status}): ${msg}`);
    }
  }
  entries.sort((a, b) => a.chain.chainId - b.chain.chainId);
  return entries;
}

function main() {
  const entries = generate();
  const out = path.join(process.cwd(), 'lib', 'chain-config.generated.json');
  writeFileSync(out, JSON.stringify(entries, null, 2) + '\n');
  console.log(`build-chain-config: wrote ${entries.length} chains → ${path.relative(process.cwd(), out)}`);
  for (const e of entries) {
    console.log(`  ${e.slug} (${e.chain.network}, ${e.chain.status}${e.bridge ? ', bridge' : ''})`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
