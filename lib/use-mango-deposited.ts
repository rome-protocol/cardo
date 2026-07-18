// useMangoDeposited — read the user's *deposited* amount in one Mango v4
// bank (what tokenWithdraw can pull without borrowing), for the /lend-mango
// withdraw view. The wallet's ATA balance is the wrong number there — it's
// what deposit consumes, not what's inside Mango.
//
// Layout facts (no Anchor client dep; parsed from raw account bytes) were
// calibrated against the LIVE devnet accounts on 2026-07-07 and are pinned
// by unit fixtures in tests/mango-deposited.test.ts:
//
// MangoAccount (dynamic zero-copy):
//   group @8, owner @40 (validated against the caller's PDA),
//   token positions start @424, stride 184:
//     indexed_position i128 I80F48 @+0, token_index u16 @+16,
//     previous_index i128 I80F48 @+24. Inactive slots carry
//     token_index = 0xFFFF.
// Bank:
//   group @8, mint @56 (both validated), deposit_index i128 I80F48 @536
//   (borrow_index @552 — the adjacent pair), token_index u16 @888
//   followed by bump u8 @890 and mint_decimals u8 @891.
//
// deposited_native = indexed_position × deposit_index  (I80F48 × I80F48,
// so >> 96 to get the integer part). Negative indexed_position = borrow →
// deposited 0.

import { useCallback, useEffect, useState } from 'react';
import type { Address, Hex } from 'viem';
import { bytes32ToPublicKey, deriveRomeUserPda } from './solana-pda';
import { deriveMangoAccount } from './mango-pdas';

const RPC = '/api/rpc/solana-devnet';
const POLL_MS = 15_000;

const ACCT_GROUP_OFFSET = 8;
const ACCT_OWNER_OFFSET = 40;
const ACCT_POSITIONS_BASE = 424;
const POSITION_STRIDE = 184;
const POSITION_TOKEN_INDEX_OFFSET = 16;
const INACTIVE_TOKEN_INDEX = 0xffff;

const BANK_GROUP_OFFSET = 8;
const BANK_MINT_OFFSET = 56;
const BANK_DEPOSIT_INDEX_OFFSET = 536;
const BANK_TOKEN_INDEX_OFFSET = 888;

const I80F48_FRACTIONAL_BITS = 48n;

function i128At(data: Uint8Array, offset: number): bigint {
  let lo = 0n;
  for (let i = 7; i >= 0; i--) lo = (lo << 8n) | BigInt(data[offset + i]);
  let hi = 0n;
  for (let i = 7; i >= 0; i--) hi = (hi << 8n) | BigInt(data[offset + 8 + i]);
  if (hi >= 1n << 63n) hi -= 1n << 64n; // sign of the high limb
  return (hi << 64n) | lo;
}

function u16At(data: Uint8Array, offset: number): number {
  return data[offset] | (data[offset + 1] << 8);
}

function bytesEq(data: Uint8Array, offset: number, expectedHex: Hex): boolean {
  const expected = expectedHex.slice(2);
  for (let i = 0; i < 32; i++) {
    const b = parseInt(expected.slice(i * 2, i * 2 + 2), 16);
    if (data[offset + i] !== b) return false;
  }
  return true;
}

/// Parse the user's deposited native amount for one bank out of raw
/// MangoAccount + Bank bytes. Returns null when the layout doesn't match
/// expectations (per the "real on-chain stats only — if a stat can't be
/// read, hide it" rule) so the UI hides the number instead of lying.
export function parseMangoDepositedNative(args: {
  mangoAccountData: Uint8Array;
  bankData: Uint8Array;
  /// Expected identities — all validated against the raw bytes.
  ownerPdaHex: Hex;
  groupHex: Hex;
  bankMintHex: Hex;
}): bigint | null {
  const { mangoAccountData: acct, bankData: bank } = args;
  if (acct.length < ACCT_POSITIONS_BASE + POSITION_STRIDE) return null;
  if (bank.length < BANK_TOKEN_INDEX_OFFSET + 4) return null;
  if (!bytesEq(acct, ACCT_GROUP_OFFSET, args.groupHex)) return null;
  if (!bytesEq(acct, ACCT_OWNER_OFFSET, args.ownerPdaHex)) return null;
  if (!bytesEq(bank, BANK_GROUP_OFFSET, args.groupHex)) return null;
  if (!bytesEq(bank, BANK_MINT_OFFSET, args.bankMintHex)) return null;

  const bankTokenIndex = u16At(bank, BANK_TOKEN_INDEX_OFFSET);
  const depositIndex = i128At(bank, BANK_DEPOSIT_INDEX_OFFSET);
  if (depositIndex <= 0n) return null;

  for (
    let o = ACCT_POSITIONS_BASE;
    o + POSITION_STRIDE <= acct.length;
    o += POSITION_STRIDE
  ) {
    const tokenIndex = u16At(acct, o + POSITION_TOKEN_INDEX_OFFSET);
    if (tokenIndex === INACTIVE_TOKEN_INDEX) continue;
    // Layout sanity: a live token_index far above Mango's bank count means
    // the positions base/stride no longer matches this account version.
    if (tokenIndex > 4096) return null;
    if (tokenIndex !== bankTokenIndex) continue;
    const indexedPosition = i128At(acct, o);
    if (indexedPosition <= 0n) return 0n; // borrow or empty — nothing to withdraw
    return (indexedPosition * depositIndex) >> (I80F48_FRACTIONAL_BITS * 2n);
  }
  return 0n; // account exists but holds no position in this bank
}

export type MangoDeposited = {
  /// Deposited amount in the bank's native units; null while loading or
  /// when the account/bank can't be read+validated.
  depositedNative: bigint | null;
  loading: boolean;
  refresh: () => void;
};

export function useMangoDeposited(args: {
  userEvmAddress: Address | undefined;
  groupHex: Hex;
  bankHex: Hex;
  bankMintHex: Hex;
  accountNum?: number;
}): MangoDeposited {
  const [depositedNative, setDepositedNative] = useState<bigint | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const { userEvmAddress, groupHex, bankHex, bankMintHex } = args;
  const accountNum = args.accountNum ?? 0;

  useEffect(() => {
    if (!userEvmAddress) {
      setDepositedNative(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    let ownerPdaHex: Hex;
    let mangoAccountBs58: string;
    let bankBs58: string;
    try {
      ownerPdaHex = deriveRomeUserPda(userEvmAddress);
      mangoAccountBs58 = bytes32ToPublicKey(
        deriveMangoAccount({ groupHex, ownerHex: ownerPdaHex, accountNum }),
      ).toBase58();
      bankBs58 = bytes32ToPublicKey(bankHex).toBase58();
    } catch {
      setDepositedNative(null);
      setLoading(false);
      return;
    }

    const probe = async () => {
      try {
        const res = await fetch(RPC, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getMultipleAccounts',
            params: [
              [mangoAccountBs58, bankBs58],
              { encoding: 'base64', commitment: 'confirmed' },
            ],
          }),
        });
        const json = await res.json();
        if (cancelled) return;
        const [acctInfo, bankInfo] = json.result?.value ?? [];
        if (!acctInfo || !bankInfo) {
          // No MangoAccount yet (or bank unreadable) — nothing deposited.
          setDepositedNative(acctInfo ? null : 0n);
          setLoading(false);
          return;
        }
        const deposited = parseMangoDepositedNative({
          mangoAccountData: Buffer.from(acctInfo.data[0], 'base64'),
          bankData: Buffer.from(bankInfo.data[0], 'base64'),
          ownerPdaHex,
          groupHex,
          bankMintHex,
        });
        setDepositedNative(deposited);
        setLoading(false);
      } catch {
        if (!cancelled) {
          setDepositedNative(null);
          setLoading(false);
        }
      }
    };
    void probe();
    const id = setInterval(probe, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [userEvmAddress, groupHex, bankHex, bankMintHex, accountNum, tick]);

  return { depositedNative, loading, refresh };
}
