// Flatten helper — closes any open Jupiter Perps position for the funded
// Solana wallet, so a perp funded run ALWAYS returns to flat (open → fill →
// close), never stranding an open position + locked collateral if a test
// fails mid-way. Node-side (build → sign → relay directly, not through the
// UI) so it works as a teardown regardless of page state.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { Keypair, VersionedTransaction } from '@solana/web3.js';

const MARKETS = ['SOL', 'ETH', 'BTC'] as const;
const SIDES = ['long', 'short'] as const;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function keyBytes(): Uint8Array {
  const path =
    process.env.E2E_SOLANA_KEY_FILE ??
    `${homedir()}/rome/.secrets/cardo-mainnet/orchestrator-v1.key`;
  return Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')));
}

/// Build a close for (market, side). Returns the build response if a position
/// exists (sim clean), or null when flat (the build 422s — no position).
async function buildClose(
  baseUrl: string,
  pubkey: string,
  market: string,
  side: string,
): Promise<{ tx: { kind: string; b64: string } } | null> {
  const r = await fetch(`${baseUrl}/api/perps/build`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ intent: { kind: 'perp', params: { market, side, action: 'close' } }, userPubkey: pubkey }),
  }).catch(() => null);
  if (!r || !r.ok) return null;
  const j = await r.json();
  return j?.tx ? j : null;
}

async function signRelay(baseUrl: string, kp: Keypair, txB64: string): Promise<string | null> {
  const tx = VersionedTransaction.deserialize(Buffer.from(txB64, 'base64'));
  tx.sign([kp]);
  const b64 = Buffer.from(tx.serialize()).toString('base64');
  const r = await fetch(`${baseUrl}/api/orchestrate/relay`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tx: { kind: 'v0', b64 } }),
  }).catch(() => null);
  if (!r) return null;
  const j = await r.json();
  return j?.status === 'Confirmed' ? (j.txSig ?? 'confirmed') : null;
}

/// True if an open position exists for (market, side) — a money-free probe
/// (the close build sims clean iff the Position exists).
export async function isPerpOpen(
  baseUrl: string,
  pubkey: string,
  market: string,
  side: string,
): Promise<boolean> {
  return (await buildClose(baseUrl, pubkey, market, side)) !== null;
}

/// Close one (market, side) if open. Retries a few times because a just-opened
/// request may not be keeper-filled yet (close 422s until the Position exists).
/// Returns 'closed' | 'flat' | 'pending' (couldn't close before the window).
export async function flattenPerp(
  baseUrl: string,
  pubkey: string,
  market: string,
  side: string,
  opts: { retries?: number } = {},
): Promise<'closed' | 'flat' | 'pending'> {
  const kp = Keypair.fromSecretKey(keyBytes());
  const retries = opts.retries ?? 1;
  for (let i = 0; i <= retries; i++) {
    const built = await buildClose(baseUrl, pubkey, market, side);
    if (!built) return i === 0 ? 'flat' : 'closed'; // 422 on first probe = never open; later = we closed it
    const sig = await signRelay(baseUrl, kp, built.tx.b64);
    if (sig) return 'closed';
    if (i < retries) await sleep(12_000); // pending keeper fill — wait + retry
  }
  return 'pending';
}

/// Flatten EVERY market/side for the wallet. Safe to call as a teardown after
/// any perp test — a no-op when already flat. Returns what it closed.
export async function flattenAllPerps(baseUrl: string, pubkey: string): Promise<string[]> {
  const closed: string[] = [];
  for (const market of MARKETS) {
    for (const side of SIDES) {
      const res = await flattenPerp(baseUrl, pubkey, market, side, { retries: 0 });
      if (res === 'closed') closed.push(`${market}-${side}`);
    }
  }
  return closed;
}
