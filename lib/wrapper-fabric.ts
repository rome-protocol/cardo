// Wrapper fabric — pure async functions that join Solana SPL mints to
// EVM-side ERC20-SPL wrappers on Rome.
//
// The pattern: every Solana protocol Cardo integrates ends up moving
// some SPL mint that the user must hold (or receive) on the EVM side.
// "Holding" on the EVM side means an ERC20-SPL wrapper exists and the
// user is bound to it. The fabric's job is to surface this lifecycle as
// a single primitive — `ensureWrapper(mint)` — so every adapter shares
// one code path.
//
// Three pieces:
//   1. `lookupWrapper(rpcUrl, mint)` — read the canonical factory's
//      `token_by_mint` mapping. Cheap eth_call.
//   2. `WrapperFlow` — opcode list for a deploy-and-bind run. The
//      React layer (use-ensure-wrapper.ts) walks this.
//   3. `recommendSymbol(mint)` — symbol/name placeholder when the
//      caller doesn't supply one (e.g. unknown memecoin).
//
// This module has zero React dependencies; the hook above is the React
// surface.

import { type Address, type Hex } from 'viem';
import { ROME_ADDRESSES } from './addresses';

const RPC = '/api/rpc/rome';
const ZERO_ADDR: Address = '0x0000000000000000000000000000000000000000';

// ─────────────────────────────────────────────────────────────────────
// 1. Lookup
// ─────────────────────────────────────────────────────────────────────

/// Look up the ERC20-SPL wrapper for a Solana mint, on Rome.
///
/// Returns `null` when no wrapper has been deployed for this mint via
/// the canonical rome-solidity factory. The factory exposes
/// `token_by_mint(bytes32) -> address` (selector `0x2ef05768`).
export async function lookupWrapper(args: {
  /// 0x-prefixed 32-byte mint pubkey (the bytes32 form, not bs58).
  mintHex: Hex;
  rpcUrl?: string;
}): Promise<Address | null> {
  const factory = ROME_ADDRESSES.erc20SplFactoryCanonical as Address;
  const data = ('0x2ef05768' + args.mintHex.slice(2)) as Hex;
  const res = await fetch(args.rpcUrl ?? RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to: factory, data }, 'latest'],
    }),
  });
  const json = await res.json();
  if (!json.result) return null;
  const addr = ('0x' + (json.result as string).slice(-40)) as Address;
  if (
    addr.length !== 42 ||
    addr.toLowerCase() === ZERO_ADDR.toLowerCase()
  ) {
    return null;
  }
  return addr;
}

/// Read the existing user-binding state for a wrapper (whether the
/// wrapper has already called `ensure_token_account` for this user).
/// True means a follow-up `mint_to`/transfer can succeed without an
/// extra binding tx.
export async function lookupUserBound(args: {
  wrapper: Address;
  user: Address;
  rpcUrl?: string;
}): Promise<boolean> {
  // _accounts[user] mapping → returns 0x00…00 when unset.
  // selector for `_accounts(address)`: keccak256("_accounts(address)")[..4]
  // We don't lock the selector here — instead we attempt a cheap
  // `balanceOf(user)` and treat a successful non-revert as "bound".
  // (Wrappers revert on balanceOf for unbound users in some builds; this
  // is conservative — when in doubt, the deploy flow is idempotent.)
  const data = ('0x70a08231' + // balanceOf(address)
    '000000000000000000000000' +
    args.user.slice(2).toLowerCase()) as Hex;
  try {
    const res = await fetch(args.rpcUrl ?? RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to: args.wrapper, data }, 'latest'],
      }),
    });
    const json = await res.json();
    return !!json.result && !json.error;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────
// 2. Deploy plan
// ─────────────────────────────────────────────────────────────────────

/// One step in the deploy + bind flow. The hook layer dispatches each
/// step as a wagmi `writeContractAsync` call and polls the receipt
/// before advancing.
export type WrapperStep =
  | { kind: 'create-user' /* register user with the factory if first time */ }
  | {
      kind: 'add-spl-token';
      /// Existing Solana mint (caller-supplied).
      mintHex: Hex;
      /// Symbol; must be unique across the factory's registry.
      symbol: string;
      /// Human-readable name.
      name: string;
    }
  | {
      kind: 'ensure-token-account';
      /// Wrapper address resolved AFTER step `add-spl-token` succeeds.
      wrapper: Address;
      /// User EOA to bind.
      user: Address;
    };

/// Plan a wrapper deploy-and-bind. The `factoryRegistered` flag tells
/// the planner whether step 1 (create_user) is needed.
export function planWrapperDeploy(args: {
  mintHex: Hex;
  symbol: string;
  name: string;
  user: Address;
  factoryRegistered: boolean;
}): WrapperStep[] {
  const out: WrapperStep[] = [];
  if (!args.factoryRegistered) out.push({ kind: 'create-user' });
  out.push({
    kind: 'add-spl-token',
    mintHex: args.mintHex,
    symbol: args.symbol,
    name: args.name,
  });
  // ensure-token-account is appended after add-spl-token resolves the
  // wrapper address. We push it as a stub here; the hook overwrites
  // `wrapper` once known.
  out.push({
    kind: 'ensure-token-account',
    wrapper: ZERO_ADDR,
    user: args.user,
  });
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// 3. Symbol / name conventions
// ─────────────────────────────────────────────────────────────────────

/// Cardo convention: ERC20-SPL wrappers are prefixed `r` (e.g. WUSDC,
/// WWSOL, WMEME) when the source mint has a known symbol. For unknown
/// mints (memecoins discovered on the fly), fall back to the first 6
/// chars of the bs58 mint as a unique-ish placeholder.
///
/// **Symbol uniqueness is enforced by the canonical factory** —
/// `add_spl_token_no_metadata` reverts on collision. Callers should
/// always allow the user to override before the deploy fires.
export function recommendSymbol(args: {
  /// Solana mint, bs58.
  mintBs58: string;
  /// Optional source-side symbol (from a registry, metadata account, or
  /// integration spec).
  sourceSymbol?: string;
}): { symbol: string; name: string } {
  if (args.sourceSymbol && args.sourceSymbol.length > 0) {
    const base = args.sourceSymbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
    return { symbol: 'r' + base, name: 'Rome-wrapped ' + args.sourceSymbol };
  }
  const fallback = args.mintBs58.slice(0, 6).toUpperCase();
  return {
    symbol: 'r' + fallback,
    name: `Rome-wrapped (mint ${args.mintBs58.slice(0, 8)}…)`,
  };
}
