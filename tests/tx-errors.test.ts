import { describe, it, expect } from 'vitest';
import { isUserRejection, summarizeTxError, truncateMiddle } from '../lib/tx-errors';

describe('isUserRejection — a MetaMask reject is NOT a revert', () => {
  it('viem UserRejectedRequestError (by name)', () => {
    expect(isUserRejection({ name: 'UserRejectedRequestError', message: 'User rejected the request.' })).toBe(true);
  });
  it('EIP-1193 code 4001', () => {
    expect(isUserRejection({ code: 4001, message: 'User denied transaction signature' })).toBe(true);
  });
  it('nested cause.code 4001 (viem wraps)', () => {
    expect(isUserRejection({ message: 'wrapper', cause: { code: 4001 } })).toBe(true);
  });
  it('ethers v6 ACTION_REJECTED', () => {
    expect(isUserRejection({ code: 'ACTION_REJECTED', message: 'user rejected action' })).toBe(true);
  });
  it('plain message ("User denied…")', () => {
    expect(isUserRejection(new Error('MetaMask Tx Signature: User denied transaction signature.'))).toBe(true);
  });
  it('an on-chain revert is NOT a rejection', () => {
    expect(isUserRejection(new Error('execution reverted: insufficient funds'))).toBe(false);
  });
  it('handles null/undefined', () => {
    expect(isUserRejection(undefined)).toBe(false);
    expect(isUserRejection(null)).toBe(false);
  });
});

describe('summarizeTxError — concise, never a giant blob', () => {
  it('a rejection summarizes to "cancelled"', () => {
    expect(summarizeTxError({ code: 4001, message: 'User denied' })).toMatch(/cancel/i);
  });
  it('a long revert blob is capped', () => {
    const out = summarizeTxError(new Error('execution reverted: ' + 'x'.repeat(800)));
    expect(out.length).toBeLessThanOrEqual(160);
    expect(out.length).toBeGreaterThan(0);
  });
});

describe('truncateMiddle — for hashes/pubkeys', () => {
  it('truncates the middle of a long hash', () => {
    expect(truncateMiddle('0x9038e557aabbccddeeff00112233445566778899', 6, 4)).toBe('0x9038…8899');
  });
  it('leaves short strings untouched', () => {
    expect(truncateMiddle('0x1234', 6, 4)).toBe('0x1234');
  });
  it('tolerates empty', () => {
    expect(truncateMiddle('', 6, 4)).toBe('');
  });
});
