// resolveRecipient — the one shared gate for /pay + /send recipient input.
// Contract: accept a Solana bs58 pubkey (native wallet) OR an EVM 0x address
// (another cardo user — routes to their chain-correct Rome external-authority
// PDA); anything else is 'invalid' WITH a human reason. The silent-no-op
// failure this replaces: /pay's length>=32 gate let 0x… addresses through to
// a swallowed `new PublicKey()` throw, so "Start stream" did nothing.

import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { resolveRecipient } from '../lib/recipient-resolve';
import {
  bytes32ToPublicKey,
  deriveRomeUserPda,
  pubkeyBs58ToBytes32,
} from '../lib/solana-pda';

const HADRIAN = 200010;
// Treasury fixtures — any well-formed values work; these are real.
const SOL_PUBKEY = '2Q93vtBvo4VJL2iN1h68fmHcSxSGuv8mzmXvFUyps2RK';
const EVM_ADDR = '0xC777615450b91C6dCf1532645C2d809C9fae2DAc';

describe('resolveRecipient', () => {
  it('resolves a Solana bs58 pubkey as a native wallet', () => {
    const r = resolveRecipient(SOL_PUBKEY, HADRIAN);
    expect(r.kind).toBe('solana');
    if (r.kind !== 'solana') return;
    expect(r.recipientHex).toBe(pubkeyBs58ToBytes32(SOL_PUBKEY));
  });

  it('resolves an EVM address to that user Rome PDA (chain-aware)', () => {
    const r = resolveRecipient(EVM_ADDR, HADRIAN);
    expect(r.kind).toBe('evm');
    if (r.kind !== 'evm') return;
    expect(r.recipientHex).toBe(deriveRomeUserPda(EVM_ADDR, HADRIAN));
    // display form: the derived PDA in bs58 so the UI can show where it routes
    expect(r.recipientBs58).toBe(
      bytes32ToPublicKey(deriveRomeUserPda(EVM_ADDR, HADRIAN)).toBase58(),
    );
  });

  it('accepts lowercase EVM addresses (no checksum requirement)', () => {
    const r = resolveRecipient(EVM_ADDR.toLowerCase(), HADRIAN);
    expect(r.kind).toBe('evm');
  });

  it('trims surrounding whitespace before classifying', () => {
    expect(resolveRecipient(`  ${SOL_PUBKEY}  `, HADRIAN).kind).toBe('solana');
    expect(resolveRecipient(`\t${EVM_ADDR}\n`, HADRIAN).kind).toBe('evm');
  });

  it('rejects a 0x address of the wrong length with a reason', () => {
    const r = resolveRecipient('0xC77761', HADRIAN);
    expect(r.kind).toBe('invalid');
    if (r.kind !== 'invalid') return;
    expect(r.reason.length).toBeGreaterThan(0);
  });

  it('rejects base58-charset violations (0, O, I, l) with a reason', () => {
    // 40 chars, right length band, but 0/O/I/l are not base58.
    const r = resolveRecipient('0OIl' + SOL_PUBKEY.slice(4), HADRIAN);
    expect(r.kind).toBe('invalid');
  });

  it('rejects a bs58 string that does not decode to 32 bytes', () => {
    // Valid base58 charset, wrong payload length (31 bytes worth).
    const r = resolveRecipient(SOL_PUBKEY.slice(0, 40), HADRIAN);
    expect(r.kind).toBe('invalid');
  });

  it('rejects empty / whitespace-only input', () => {
    expect(resolveRecipient('', HADRIAN).kind).toBe('invalid');
    expect(resolveRecipient('   ', HADRIAN).kind).toBe('invalid');
  });

  it('EVM resolution differs per chain (PDA seeds include the chain program)', () => {
    // Martius (121214) is in the compiled chain set; its rome-evm program
    // differs from Hadrian's, so the derived PDA must differ too.
    const hadrian = resolveRecipient(EVM_ADDR, HADRIAN);
    const martius = resolveRecipient(EVM_ADDR, 121214);
    expect(hadrian.kind).toBe('evm');
    expect(martius.kind).toBe('evm');
    if (hadrian.kind !== 'evm' || martius.kind !== 'evm') return;
    expect(hadrian.recipientHex).not.toBe(martius.recipientHex);
  });

  it('round-trips: a resolved solana recipient equals PublicKey normalization', () => {
    const r = resolveRecipient(SOL_PUBKEY, HADRIAN);
    if (r.kind !== 'solana') throw new Error('expected solana');
    expect(new PublicKey(SOL_PUBKEY).toBase58()).toBe(SOL_PUBKEY);
    expect(r.recipientBs58).toBe(SOL_PUBKEY);
  });
});
