// Transaction error classification + presentation.
//
// A MetaMask "Reject" is NOT an on-chain revert — nothing was submitted, so it
// must read as "Transaction cancelled" (neutral), never "Reverted/failed" (red).
// EIP-1193 user rejection = code 4001; ethers v6 = 'ACTION_REJECTED'; viem throws
// UserRejectedRequestError (name) carrying code 4001 (often nested under .cause).
// We check every shape plus a message fallback so the classification is robust
// across the swap/lend/stake/pay/send/bridge hooks (mixed viem + ethers).

const REJECT_RE =
  /user rejected|user denied|rejected the request|denied transaction|request rejected|user cancelled|user canceled/i;

function errorCodes(e: unknown): unknown[] {
  if (!e || typeof e !== 'object') return [];
  const o = e as Record<string, any>;
  return [o.code, o.cause?.code, o.cause?.cause?.code, o.info?.error?.code, o.error?.code];
}

/** True when the failure is the user rejecting the signature (not a revert). */
export function isUserRejection(e: unknown): boolean {
  if (!e) return false;
  const o = e as Record<string, any>;
  if (o.name === 'UserRejectedRequestError') return true;
  for (const c of errorCodes(o)) {
    if (c === 4001 || c === 'ACTION_REJECTED') return true;
  }
  const msg = typeof e === 'string' ? e : (o.shortMessage || o.message || '');
  return REJECT_RE.test(String(msg));
}

/** A short, human one-liner. Rejections collapse to "Transaction cancelled";
 *  reverts are trimmed to one line and capped so nothing dumps a giant blob. */
export function summarizeTxError(e: unknown): string {
  if (isUserRejection(e)) return 'Transaction cancelled';
  const o = e as Record<string, any>;
  let msg =
    typeof e === 'string' ? e : (o?.shortMessage || o?.message || String(e ?? 'Transaction failed'));
  msg = String(msg).split('\n')[0].trim();
  msg = msg.replace(/^(Error|TransactionExecutionError|ContractFunctionExecutionError|ViemError):\s*/i, '');
  if (msg.length > 160) msg = msg.slice(0, 157).trimEnd() + '…';
  return msg || 'Transaction failed';
}

/** Middle-ellipsis for hashes / pubkeys: 0x9038…8899. Short strings pass through. */
export function truncateMiddle(s: string, head = 6, tail = 4): string {
  if (!s) return s;
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}
