// resolveRecipient — the one shared recipient gate for /pay + /send.
//
// Cardo users are EVM wallets, so "pay another cardo user" naturally means
// pasting an EVM 0x address — but the streams/transfers land on Solana, so
// the on-chain recipient must be a Solana pubkey. This helper accepts BOTH
// forms and normalizes them:
//   * Solana bs58 pubkey  → used as-is (native wallet recipient)
//   * EVM 0x address      → that user's Rome external-authority PDA on the
//     ACTIVE chain (their funds show up in cardo, same as bridged balances).
//     Chain-aware: the PDA is seeded by the chain's rome-evm program, so the
//     chainId must be threaded from useActiveChainId (module-frozen defaults
//     broke Martius — see lib/solana-pda.ts).
// Anything else is 'invalid' with a human reason — callers must SHOW it.
// (The /pay bug this kills: a length-only gate let 0x… through to a swallowed
// `new PublicKey()` throw, so "Start stream" silently did nothing.)

import { PublicKey } from '@solana/web3.js';
import type { Hex } from 'viem';
import {
  bytes32ToPublicKey,
  deriveRomeUserPda,
  pubkeyBs58ToBytes32,
} from './solana-pda';

export type ResolvedRecipient =
  | {
      kind: 'solana';
      /// bytes32 form for AccountMeta wiring.
      recipientHex: Hex;
      /// bs58 form for display.
      recipientBs58: string;
    }
  | {
      kind: 'evm';
      /// The recipient's Rome PDA (bytes32) on the resolved chain.
      recipientHex: Hex;
      recipientBs58: string;
      /// The 0x address as entered (checksum-insensitive).
      evmAddress: string;
    }
  | { kind: 'invalid'; reason: string };

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;

export function resolveRecipient(
  input: string,
  chainId?: number,
): ResolvedRecipient {
  const s = (input ?? '').trim();
  if (!s) return { kind: 'invalid', reason: 'Enter a recipient address.' };

  if (s.startsWith('0x') || s.startsWith('0X')) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(s)) {
      return {
        kind: 'invalid',
        reason: 'Not a valid EVM address — expected 0x + 40 hex characters.',
      };
    }
    const recipientHex = deriveRomeUserPda(s, chainId);
    return {
      kind: 'evm',
      recipientHex,
      recipientBs58: bytes32ToPublicKey(recipientHex).toBase58(),
      evmAddress: s,
    };
  }

  if (s.length < 32 || s.length > 44 || !BASE58_RE.test(s)) {
    return {
      kind: 'invalid',
      reason:
        'Not a valid address — paste a Solana wallet (base58) or an EVM 0x address.',
    };
  }
  try {
    const pk = new PublicKey(s); // throws unless it decodes to 32 bytes
    return {
      kind: 'solana',
      recipientHex: pubkeyBs58ToBytes32(pk.toBase58()),
      recipientBs58: pk.toBase58(),
    };
  } catch {
    return {
      kind: 'invalid',
      reason: 'Not a valid Solana address (must decode to 32 bytes).',
    };
  }
}
