// Local record of Streamflow streams the user has created, so the Pay "Manage"
// tab can offer a pick-from-list instead of asking the user to paste a stream's
// metadata PDA (which would mean looking it up on Solana — against the
// "everything in-UI" rule).
//
// Why local-record (not on-chain enumeration): the metadata PDA is deterministic
// from (mint, sender, nonce) and the sender IS the user, but the nonce is random
// per stream — so past PDAs can't be re-derived. Rather than decode the
// Streamflow account layout (needs an external IDL), we capture each stream at
// creation time, where the app already knows every field the Manage actions need
// (PDA, recipient, mint, name, amount). Limitation: shows streams created in this
// browser; cross-device enumeration would need the on-chain decoder (future).

export type StoredStream = {
  metadataPda: string; // bs58 — the Manage actions' key input
  recipient: string; // bs58
  mint: string; // bs58 (the SPL mint)
  name: string;
  amount: string; // human, for display
  cancelable: boolean;
  /// Whether the stream was created with can_topup (immutable on-chain).
  /// Absent on records from before topup-able creates shipped — those
  /// streams were created with can_topup=false and can never be topped up.
  canTopup?: boolean;
  createdAt: number; // ms epoch
};

// ── pure list ops (unit-tested) ──────────────────────────────────────────────
/** Prepend (newest first); dedupe by metadataPda so re-adding replaces in place. */
export function addStream(prev: StoredStream[], s: StoredStream): StoredStream[] {
  return [s, ...prev.filter((x) => x.metadataPda !== s.metadataPda)];
}
export function removeStreamFrom(prev: StoredStream[], metadataPda: string): StoredStream[] {
  return prev.filter((x) => x.metadataPda !== metadataPda);
}

// ── storage-backed (browser localStorage; injectable for tests) ──────────────
type Storageish = { getItem(k: string): string | null; setItem(k: string, v: string): void };

function defaultStorage(): Storageish | null {
  try {
    if (typeof globalThis !== 'undefined' && (globalThis as { localStorage?: Storageish }).localStorage) {
      return (globalThis as unknown as { localStorage: Storageish }).localStorage;
    }
  } catch {
    /* access denied (SSR / privacy mode) */
  }
  return null;
}

const keyFor = (addr: string) => `cardo:streams:${addr.toLowerCase()}`;

export function listStreams(addr: string, storage: Storageish | null = defaultStorage()): StoredStream[] {
  if (!storage || !addr) return [];
  try {
    const raw = storage.getItem(keyFor(addr));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StoredStream[]) : [];
  } catch {
    return []; // corrupt / unparseable → empty, never throw into render
  }
}

export function recordStream(
  addr: string,
  s: StoredStream,
  storage: Storageish | null = defaultStorage(),
): void {
  if (!storage || !addr) return;
  try {
    const next = addStream(listStreams(addr, storage), s);
    storage.setItem(keyFor(addr), JSON.stringify(next));
  } catch {
    /* quota / denied — non-fatal */
  }
}

export function forgetStream(
  addr: string,
  metadataPda: string,
  storage: Storageish | null = defaultStorage(),
): void {
  if (!storage || !addr) return;
  try {
    const next = removeStreamFrom(listStreams(addr, storage), metadataPda);
    storage.setItem(keyFor(addr), JSON.stringify(next));
  } catch {
    /* non-fatal */
  }
}
