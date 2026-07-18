// PDA derivations for Kamino Lend.
//
// All derivations are pure: input parameters → bytes32 hex via
// `@solana/web3.js`'s `findProgramAddressSync`. No network reads.
//
// Source: github.com/Kamino-Finance/klend (programs/klend/src/utils/seeds.rs) +
//   the docs/active/technical/2026-04-25-cardo-lend-kamino-triage.md §1.2
//
// Per the integration playbook §1.2: PDAs that *appear* in a write
// instruction's account list and whose state we read (Reserve,
// Obligation, UserMetadata) MUST also be cross-verified against the
// on-chain stored value at submit time. Don't trust the derivation
// alone — see Meteora's WSOL `lp_mint` non-PDA case (playbook §4.1).

import { PublicKey } from '@solana/web3.js';
import type { Hex } from 'viem';
import { bytes32ToPublicKey, pubkeyToBytes32 } from './solana-pda';
import { solanaProgramId } from './solana-programs';

const KLEND_PROGRAM_ID = new PublicKey(solanaProgramId('kaminoLend', 'mainnet'));

// ─────────────────────────────────────────────────────────────────────
// Lending market authority — PDA(["lma", lendingMarket], KLEND).
//
// Acts as the signer authority for liquidity-vault SPL transfers
// inside Kamino's instructions. Required as a [readonly] account in
// every write op.
// ─────────────────────────────────────────────────────────────────────
export function deriveLendingMarketAuthority(lendingMarketHex: Hex): Hex {
  const market = bytes32ToPublicKey(lendingMarketHex);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('lma'), market.toBuffer()],
    KLEND_PROGRAM_ID,
  );
  return pubkeyToBytes32(pda);
}

// ─────────────────────────────────────────────────────────────────────
// User metadata — PDA(["user_meta", owner], KLEND).
//
// Kamino v2 requires UserMetadata to exist before any obligation can
// be created. One per user (independent of market). `owner` here is
// the Solana-side owner pubkey — for Cardo that's the user's Rome PDA
// (per playbook §1.5: msg.sender == userEoa at the CPI precompile,
// Rome signs as PDA([EXTERNAL_AUTHORITY, userEoaBytes], ROME_EVM)).
// ─────────────────────────────────────────────────────────────────────
export function deriveUserMetadata(ownerHex: Hex): Hex {
  const owner = bytes32ToPublicKey(ownerHex);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('user_meta'), owner.toBuffer()],
    KLEND_PROGRAM_ID,
  );
  return pubkeyToBytes32(pda);
}

// ─────────────────────────────────────────────────────────────────────
// Vanilla obligation — PDA([0, 0, owner, market, zero, zero], KLEND).
//
// Six seeds matching `KaminoLendProgram.vanillaObligationSeeds`:
//   [ tag(u8)=0, id(u8)=0, owner(32), lending_market(32), zero32, zero32 ]
//
// Vanilla = no preset, no obligation kind. Other variants
// (MarketKind, BoosterKind) are post-MVP per the triage doc §7.4.
// ─────────────────────────────────────────────────────────────────────
export function deriveVanillaObligation(
  ownerHex: Hex,
  lendingMarketHex: Hex,
): Hex {
  const owner = bytes32ToPublicKey(ownerHex);
  const market = bytes32ToPublicKey(lendingMarketHex);
  const zero = Buffer.alloc(32);
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from([0]), // tag
      Buffer.from([0]), // id
      owner.toBuffer(),
      market.toBuffer(),
      zero, // seed1 (Vanilla)
      zero, // seed2 (Vanilla)
    ],
    KLEND_PROGRAM_ID,
  );
  return pubkeyToBytes32(pda);
}
