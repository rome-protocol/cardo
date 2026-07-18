// Read the user's Kamino obligation state from Solana — actual
// deposits + borrows, not mock data. Per playbook §4b.11: the user
// must see truth about their position; never show fake numbers.
//
// Obligation struct layout (cross-checked against
//   github.com/Kamino-Finance/klend programs/klend/src/state/obligation.rs
// and probed empirically against a fresh user obligation on devnet
// 2026-04-25):
//
//   off    field
//   ----   -------------------------------------------------
//      0   account discriminator (8 bytes; sha256("account:Obligation")[..8])
//      8   tag (u64 LE)
//     16   last_update.slot (u64)
//     24   last_update.stale (u8) + padding to next 8-byte boundary
//     32   lending_market (Pubkey, 32 bytes)
//     64   owner (Pubkey, 32 bytes)
//     96   deposits[8] — ObligationCollateral, 136 bytes each
//   1184   lowest_reserve_deposit_liquidation_ltv (u64)
//   1192   deposited_value_sf (u128, 16 bytes)
//   1208   borrows[5] — ObligationLiquidity, 144 bytes each
//
// ObligationCollateral (136 bytes):
//   off    field
//   ----   ------------------
//      0   deposit_reserve (32)
//     32   deposited_amount (u64)
//     40   market_value_sf (u128, 16)
//     56   borrowed_amount_against_this_collateral_in_elevation_group (u64)
//     64   padding [u64; 9] (72)
//
// ObligationLiquidity (144 bytes):
//   off    field
//   ----   ------------------
//      0   borrow_reserve (32)
//     32   cumulative_borrow_rate_bsf BigFractionBytes (48: [u64; 4] + padding [u64; 2])
//     80   last_borrowed_at_timestamp (u64)
//     88   borrowed_amount_sf (u128, 16)
//    104   market_value_sf (u128, 16)
//    120   borrow_factor_adjusted_market_value_sf (u128, 16)
//    136   borrowed_amount_outside_elevation_groups (u64)
//
// 8s polling + memoized refresh per playbook §4b.5.

import { useCallback, useEffect, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import type { Address, Hex } from 'viem';
import { bytes32ToPublicKey, deriveRomeUserPda, pubkeyToBytes32 } from './solana-pda';
import { deriveVanillaObligation } from './kamino-pdas';

const REFRESH_MS = 8_000;

const KLEND_OWNER = 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD';
const ZERO_PUBKEY = '11111111111111111111111111111111';

const DEPOSITS_OFFSET = 96;
const DEPOSIT_ITEM_SIZE = 136;
const NUM_DEPOSIT_SLOTS = 8;
const BORROWS_OFFSET = 1208;
const BORROW_ITEM_SIZE = 144;
const NUM_BORROW_SLOTS = 5;

export type ObligationDeposit = {
  /// Reserve account this deposit is against (bytes32 hex).
  reserveHex: Hex;
  /// Deposited collateral amount in cToken raw units (u64).
  /// To get the underlying liquidity amount, multiply by the reserve's
  /// collateral exchange rate — out of scope until we add reserve-state polling.
  depositedAmount: bigint;
  /// Market value in 1e18-scaled USD (Kamino's `sf` = scaled-fraction).
  /// Low 64 bits only (full u128 not needed for display).
  marketValueLow: bigint;
};

export type ObligationBorrow = {
  reserveHex: Hex;
  /// Borrowed amount in liquidity raw units. Low 64 bits of the u128 sf.
  borrowedAmountLow: bigint;
  marketValueLow: bigint;
};

export type ObligationState = {
  /// Has the user been initialized at all?
  exists: boolean;
  /// Active deposit positions (slot was non-zero).
  deposits: ObligationDeposit[];
  /// Active borrow positions.
  borrows: ObligationBorrow[];
  /// Total deposited value (USD, sf-low).
  depositedValueLow: bigint;
  loading: boolean;
};

function readPubkeyHex(data: Buffer, off: number): Hex {
  return pubkeyToBytes32(new PublicKey(data.subarray(off, off + 32)));
}

export function useKaminoObligationState(args: {
  userEvmAddress: Address | undefined;
  lendingMarket: Hex | undefined;
}): ObligationState & { refresh: () => void } {
  const [state, setState] = useState<ObligationState>({
    exists: false,
    deposits: [],
    borrows: [],
    depositedValueLow: 0n,
    loading: false,
  });
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  const obligation =
    args.userEvmAddress && args.lendingMarket
      ? deriveVanillaObligation(
          deriveRomeUserPda(args.userEvmAddress),
          args.lendingMarket,
        )
      : undefined;

  useEffect(() => {
    if (!obligation) {
      setState({
        exists: false,
        deposits: [],
        borrows: [],
        depositedValueLow: 0n,
        loading: false,
      });
      return;
    }
    let cancelled = false;
    const obligationBs58 = bytes32ToPublicKey(obligation).toBase58();

    const run = async () => {
      setState((s) => ({ ...s, loading: true }));
      try {
        const res = await fetch('/api/rpc/solana-devnet', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getAccountInfo',
            params: [obligationBs58, { encoding: 'base64' }],
          }),
        });
        const json = await res.json();
        if (cancelled) return;
        const acc = json.result?.value;
        if (!acc || acc.owner !== KLEND_OWNER) {
          setState({
            exists: false,
            deposits: [],
            borrows: [],
            depositedValueLow: 0n,
            loading: false,
          });
          return;
        }
        const data = Buffer.from(acc.data[0], 'base64');

        const deposits: ObligationDeposit[] = [];
        for (let i = 0; i < NUM_DEPOSIT_SLOTS; i++) {
          const base = DEPOSITS_OFFSET + i * DEPOSIT_ITEM_SIZE;
          const reservePk = new PublicKey(data.subarray(base, base + 32));
          const depositedAmount = data.readBigUInt64LE(base + 32);
          if (reservePk.toBase58() === ZERO_PUBKEY && depositedAmount === 0n) {
            continue;
          }
          deposits.push({
            reserveHex: readPubkeyHex(data, base),
            depositedAmount,
            marketValueLow: data.readBigUInt64LE(base + 40),
          });
        }

        const borrows: ObligationBorrow[] = [];
        for (let i = 0; i < NUM_BORROW_SLOTS; i++) {
          const base = BORROWS_OFFSET + i * BORROW_ITEM_SIZE;
          if (base + BORROW_ITEM_SIZE > data.length) break;
          const reservePk = new PublicKey(data.subarray(base, base + 32));
          const borrowedAmountLow = data.readBigUInt64LE(base + 88);
          if (reservePk.toBase58() === ZERO_PUBKEY && borrowedAmountLow === 0n) {
            continue;
          }
          borrows.push({
            reserveHex: readPubkeyHex(data, base),
            borrowedAmountLow,
            marketValueLow: data.readBigUInt64LE(base + 104),
          });
        }

        const depositedValueLow = data.readBigUInt64LE(1192);

        setState({
          exists: true,
          deposits,
          borrows,
          depositedValueLow,
          loading: false,
        });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[cardo lend] obligation-state read failed', e);
        if (!cancelled) {
          setState((s) => ({ ...s, loading: false }));
        }
      }
    };

    run();
    const id = setInterval(run, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [obligation, tick]);

  return { ...state, refresh };
}
