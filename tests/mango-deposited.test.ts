// parseMangoDepositedNative — pins the raw-byte layout offsets against
// REAL devnet account snapshots (captured 2026-07-07 via getAccountInfo
// on Rome's internal devnet RPC):
//   tests/fixtures/mango-sol-bank.b64          — Bank 7trXn2uYWg1FSQhVsWw8mwBXeC9K75PnXVkVQcfE57NH
//   tests/fixtures/mango-account-treasury.b64  — MangoAccount Ee8EBjczcuF3CB9uN8HHgzUuw7VQY77PGJAR2BBbfB4a
//     (owner = e2e treasury's Rome PDA 2Q93vtBvo4VJL2iN1h68fmHcSxSGuv8mzmXvFUyps2RK,
//      holding an indexed_position of 6.0 against deposit_index 1e6 →
//      6_000_000 native = 0.006 SOL)
//
// If mango-v4 ever changes MangoAccount/Bank layout these fixtures keep
// passing (they're snapshots) — the hook's own validation guards (group /
// owner / mint byte checks + token_index sanity) are what protect runtime.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseMangoDepositedNative } from '../lib/use-mango-deposited';
import { pubkeyBs58ToBytes32 } from '../lib/solana-pda';

const FIX = join(__dirname, 'fixtures');
const bankData = Buffer.from(readFileSync(join(FIX, 'mango-sol-bank.b64'), 'utf8'), 'base64');
const acctData = Buffer.from(
  readFileSync(join(FIX, 'mango-account-treasury.b64'), 'utf8'),
  'base64',
);

const GROUP = pubkeyBs58ToBytes32('FHnZBXLaKBKLg8Qwzt31Ft2ZDNbkM9j4UWREkYP4o25d');
const OWNER = pubkeyBs58ToBytes32('2Q93vtBvo4VJL2iN1h68fmHcSxSGuv8mzmXvFUyps2RK');
const WSOL = pubkeyBs58ToBytes32('So11111111111111111111111111111111111111112');

describe('parseMangoDepositedNative', () => {
  it('reads the treasury deposit out of live snapshots (0.006 SOL)', () => {
    const native = parseMangoDepositedNative({
      mangoAccountData: acctData,
      bankData,
      ownerPdaHex: OWNER,
      groupHex: GROUP,
      bankMintHex: WSOL,
    });
    expect(native).toBe(6_000_000n);
  });

  it('rejects an account whose owner does not match', () => {
    const native = parseMangoDepositedNative({
      mangoAccountData: acctData,
      bankData,
      ownerPdaHex: GROUP, // wrong on purpose
      groupHex: GROUP,
      bankMintHex: WSOL,
    });
    expect(native).toBeNull();
  });

  it('rejects a bank whose mint does not match', () => {
    const native = parseMangoDepositedNative({
      mangoAccountData: acctData,
      bankData,
      ownerPdaHex: OWNER,
      groupHex: GROUP,
      bankMintHex: GROUP, // wrong on purpose
    });
    expect(native).toBeNull();
  });

  it('returns null on truncated account data instead of garbage', () => {
    const native = parseMangoDepositedNative({
      mangoAccountData: acctData.subarray(0, 300),
      bankData,
      ownerPdaHex: OWNER,
      groupHex: GROUP,
      bankMintHex: WSOL,
    });
    expect(native).toBeNull();
  });
});
