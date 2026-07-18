// Generates lib/solana-programs.generated.json — Cardo's compiled Solana program
// ID + LST mint tables — from the installed @rome-protocol/registry pin (the same
// build-time-projection pattern as build-chain-config.ts). Reading the registry
// HERE, at build time, keeps the server-only registry package out of the browser
// bundle: lib/solana-programs.ts imports the committed JSON, never the package
// (the package resolves its data from disk via node:fs/node:url and can't be
// bundled for the client).
//
// Runs in `npm run build` (so the image regenerates from its registry pin) and
// standalone via `npm run build:solana-programs`. The output is COMMITTED;
// tests/solana-programs-generated.test.ts fails when it drifts from the pin.

import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { getPrograms, getLstMints } from '@rome-protocol/registry';

export function generate() {
  return {
    mainnet: getPrograms('mainnet'),
    devnet: getPrograms('devnet'),
    lstMints: getLstMints(),
  };
}

function main() {
  const data = generate();
  const out = path.join(process.cwd(), 'lib', 'solana-programs.generated.json');
  writeFileSync(out, JSON.stringify(data, null, 2) + '\n');
  const n = (o: object) => Object.keys(o).length;
  console.log(
    `build-solana-programs: wrote ${n(data.mainnet)} mainnet + ${n(data.devnet)} devnet ` +
      `programs, ${n(data.lstMints)} LST mints → ${path.relative(process.cwd(), out)}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
