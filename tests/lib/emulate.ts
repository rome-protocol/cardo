// rome_emulateTx wrapper for the unhappy-path test harness.
//
// Every test in `tests/cases/*.ts` builds a CPI invoke (via the same
// `lib/<protocol>-instructions.ts` builders the React hooks use), wraps
// it in an EVM tx signed by the shared treasury, and submits to
// Rome's proxy via `rome_emulateTx`. The emulator runs the full
// Solana CPI without landing on chain — failures surface as either:
//
//   * proxy-level error in `result.error` (e.g. "account not found: X"
//     from Rome's strict-mode account loader)
//   * Solana program return code in the logs (e.g.
//     "Program <id> failed: custom program error: 0x17c7")
//   * Anchor-style InstructionFallbackNotFound when discriminator
//     doesn't match a known method
//
// We normalize all of those into a single string `revertReason` so
// `expect.revertContains` can assert against a substring.

import { encodeFunctionData, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CPI_INVOKE_ABI, CPI_PRECOMPILE, type AccountMeta } from '../../lib/cpi-precompile';

// Rome devnet constants. Mirrored locally instead of importing
// `lib/wagmi.ts` because that module pulls RainbowKit / Reown which
// fetches a remote config at module load and noisily warns in Node.
// Keep these in sync if Cardo ever switches default chain.
export const CHAIN_ID = Number(process.env.ROME_CHAIN_ID ?? 200010); // Hadrian (devnet); was 999999 (dead chain)
export const GAS_PRICE = 11_000_000_000n; // Rome min, matches scripts/verify-swap.mjs
export const GAS_LIMIT = 50_000_000n;
export const RPC_URL =
  process.env.ROME_RPC_URL ?? 'https://hadrian.testnet.romeprotocol.xyz/';

export type Invoke = {
  program: Hex;
  accounts: AccountMeta[];
  data: Hex;
};

export type EmulateOutcome =
  | { status: 'success'; logs: string[]; raw: unknown }
  | { status: 'failed'; revertReason: string; logs: string[]; raw: unknown };

/// Submit one rome_emulateTx and return a normalized outcome.
/// Throws only on transport-level failures (network, malformed JSON);
/// any program/proxy revert is captured as `status: 'failed'`.
export async function emulateInvoke(args: {
  pk: `0x${string}`;
  invoke: Invoke;
  /// Optional override; defaults to GAS_LIMIT. Used to test the
  /// "out of gas" branch if a future case wants it.
  gasLimit?: bigint;
}): Promise<EmulateOutcome> {
  const account = privateKeyToAccount(args.pk);

  // Build calldata for invoke(bytes32 program, AccountMeta[] accounts, bytes data).
  const calldata = encodeFunctionData({
    abi: CPI_INVOKE_ABI,
    functionName: 'invoke',
    args: [args.invoke.program, args.invoke.accounts, args.invoke.data],
  });

  // Fetch nonce. Use 'pending' so successive cases in the same run
  // don't collide on the same nonce (emulation doesn't actually bump
  // the on-chain nonce, but the proxy validates monotonicity).
  const nonceRes = await rpc('eth_getTransactionCount', [account.address, 'pending']);
  if (nonceRes.error) throw new Error(`nonce fetch failed: ${JSON.stringify(nonceRes.error)}`);
  const nonce = Number.parseInt(nonceRes.result as string, 16);

  // Sign as legacy (type-0) tx — matches the rest of Cardo's CPI
  // submission path; Rome's proxy accepts legacy without EIP-1559.
  const signedTx = await account.signTransaction({
    chainId: CHAIN_ID,
    type: 'legacy',
    nonce,
    gasPrice: GAS_PRICE,
    gas: args.gasLimit ?? GAS_LIMIT,
    to: CPI_PRECOMPILE,
    value: 0n,
    data: calldata,
  });

  const emu = await rpc('rome_emulateTx', [signedTx]);

  // Shape a: top-level JSON-RPC error.
  if (emu.error) {
    return {
      status: 'failed',
      revertReason: stringifyError(emu.error),
      logs: [],
      raw: emu,
    };
  }

  // Shape b: result with explicit failure shape. The proxy returns
  // either a logs array on success or an error/exit_reason field on
  // failure. We capture both into `logs` and try a few common
  // reason fields.
  const result = emu.result as Record<string, unknown> | undefined;
  const logs = extractLogs(result);
  const reason = extractRevertReason(result, logs);
  if (reason) {
    return { status: 'failed', revertReason: reason, logs, raw: emu };
  }
  return { status: 'success', logs, raw: emu };
}

/// Submit a raw-calldata EVM tx (arbitrary `to` + `data`) via
/// rome_emulateTx. Unlike `emulateInvoke` — which always targets the CPI
/// precompile with `invoke(...)` calldata — this lets cases exercise the
/// other Rome precompiles directly (Withdraw 0x42..16 wrap leg,
/// HelperProgram 0xff..09 unwrap leg, etc.). Same normalized outcome.
export async function emulateRaw(args: {
  pk: `0x${string}`;
  to: Hex;
  data: Hex;
  gasLimit?: bigint;
}): Promise<EmulateOutcome> {
  const account = privateKeyToAccount(args.pk);

  const nonceRes = await rpc('eth_getTransactionCount', [account.address, 'pending']);
  if (nonceRes.error) throw new Error(`nonce fetch failed: ${JSON.stringify(nonceRes.error)}`);
  const nonce = Number.parseInt(nonceRes.result as string, 16);

  const signedTx = await account.signTransaction({
    chainId: CHAIN_ID,
    type: 'legacy',
    nonce,
    gasPrice: GAS_PRICE,
    gas: args.gasLimit ?? GAS_LIMIT,
    to: args.to as `0x${string}`,
    value: 0n,
    data: args.data,
  });

  const emu = await rpc('rome_emulateTx', [signedTx]);
  if (emu.error) {
    return { status: 'failed', revertReason: stringifyError(emu.error), logs: [], raw: emu };
  }
  const result = emu.result as Record<string, unknown> | undefined;
  const logs = extractLogs(result);
  const reason = extractRevertReason(result, logs);
  if (reason) return { status: 'failed', revertReason: reason, logs, raw: emu };
  return { status: 'success', logs, raw: emu };
}

async function rpc(method: string, params: unknown[]): Promise<{ result?: unknown; error?: unknown }> {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) {
    return { error: { code: res.status, message: `HTTP ${res.status}` } };
  }
  return res.json() as Promise<{ result?: unknown; error?: unknown }>;
}

function stringifyError(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const e = error as { message?: string; data?: unknown; code?: number };
    const parts: string[] = [];
    if (typeof e.code === 'number') parts.push(`code=${e.code}`);
    if (e.message) parts.push(e.message);
    if (e.data && typeof e.data === 'string') parts.push(e.data);
    else if (e.data) parts.push(JSON.stringify(e.data));
    return parts.join(' ').trim() || JSON.stringify(error);
  }
  return JSON.stringify(error);
}

function extractLogs(result: unknown): string[] {
  if (!result || typeof result !== 'object') return [];
  const r = result as Record<string, unknown>;
  // Rome's emulator response shapes vary by version; try a few keys.
  for (const key of ['logs', 'log_messages', 'simulation_logs']) {
    const v = r[key];
    if (Array.isArray(v)) return v.filter((s): s is string => typeof s === 'string');
  }
  // Some shapes wrap logs inside `result.execution_result.logs` etc.
  for (const key of ['execution_result', 'execution', 'result']) {
    const sub = r[key];
    if (sub && typeof sub === 'object') {
      const s = (sub as Record<string, unknown>).logs;
      if (Array.isArray(s)) return s.filter((x): x is string => typeof x === 'string');
    }
  }
  return [];
}

function extractRevertReason(result: unknown, logs: string[]): string | null {
  if (!result || typeof result !== 'object') {
    // No structured result — fall back to any "failed" log line.
    return findFailureLog(logs);
  }
  const r = result as Record<string, unknown>;
  // Common explicit failure fields the proxy can emit.
  for (const key of ['exit_reason', 'error', 'revert_reason', 'failure', 'status']) {
    const v = r[key];
    if (typeof v === 'string' && v.toLowerCase() !== 'success' && v.toLowerCase() !== 'ok' && v !== '0x1') {
      return v;
    }
    if (v && typeof v === 'object') {
      // viem-style { reason: ... } or { code: ..., message: ... }
      const sub = v as Record<string, unknown>;
      if (typeof sub.reason === 'string') return sub.reason;
      if (typeof sub.message === 'string') return sub.message;
    }
  }
  // No top-level failure; look in the logs for "failed" / "Custom" lines.
  return findFailureLog(logs);
}

function findFailureLog(logs: string[]): string | null {
  // Scan reversed so the most-recent failure wins (helps when
  // multiple programs log).
  for (let i = logs.length - 1; i >= 0; i--) {
    const l = logs[i];
    if (
      l.includes('failed:') ||
      l.includes('Custom(') ||
      l.includes('InstructionFallbackNotFound') ||
      l.includes('AccountNotInitialized') ||
      l.includes('account not found') ||
      l.toLowerCase().includes('error')
    ) {
      return l;
    }
  }
  return null;
}

// Surface a few commonly-asserted-against substrings as named constants.
// Keep these in sync with what `extractRevertReason` actually surfaces
// on Rome today; if the proxy normalizes its error shape later, only
// these need updating.
export const REVERT_PATTERNS = {
  /// Rome strict-mode loader's error when an `is_writable=true` account
  /// referenced by the CPI doesn't exist on the current Solana cluster.
  ACCOUNT_NOT_FOUND: 'account not found',
  /// Anchor's "no method matches this 8-byte discriminator" error.
  INSTRUCTION_FALLBACK_NOT_FOUND: 'InstructionFallbackNotFound',
  /// Anchor's "expected an initialized PDA but it was empty" error.
  ACCOUNT_NOT_INITIALIZED: 'AccountNotInitialized',
  /// Solana's generic "this program returned a non-zero error code".
  CUSTOM_ERROR_PREFIX: 'custom program error',
} as const;

