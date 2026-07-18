// Wrap/unwrap fabric — Rome's native-gas ↔ chain-mint-id SPL conversion.
//
// MIGRATION (2026-05-12 → present): the standalone precompiles this
// module used to target —
//   wrap_gas_to_spl   @ 0x42..18  (0x79a25e80)   — DELETED
//   unwrap_spl_to_gas @ 0x42..17  (0x1e34b809)   — DELETED
// were removed in the HelperProgram consolidation (the Rome EVM program
// #348/#351/#352/#353; rome-solidity #137→#143). They now revert. The two
// legs are:
//   WRAP   native gas → chain-mint SPL (into user's PDA-owned ATA):
//          Withdraw.withdraw_to_ata(uint256 wei_)   @ 0x42..16  0x8059abc0
//   UNWRAP chain-mint SPL (from user's PDA-owned ATA) → native gas:
//          HelperProgram.deposit_from_ata(uint256 wei_) @ 0xff..09 0x4479b709
//
// Selectors re-derived via keccak256(sig)[..4] and confirmed against
// rome-solidity/contracts/interface.sol (IWithdraw / IHelperProgram).
// This mirrors the Rome web app's production hook
// `src/features/portfolio/hooks/useWrapUnwrap.ts` (the Rome web app PR #245, live).
//
// SCOPE — IMPORTANT:
//   These precompiles convert the chain's gas-backing mint (the
//   `chain_mint_id`, Circle USDC on Rome) ↔ native gas balance, landing
//   the SPL in the user's PDA-owned ATA. For any OTHER ERC20-SPL wrapper
//   (wSOL, wETH, …), `SPL_ERC20_cached.balanceOf(user)` already reads the
//   live SPL ATA balance — the wrapper IS the ATA; there is no wrap step,
//   and the UI must not surface one.

import { type Address, type Hex } from 'viem';

// ─────────────────────────────────────────────────────────────────────
// Precompile addresses (canonical, interface.sol)
// ─────────────────────────────────────────────────────────────────────

/// Withdraw precompile — hosts the WRAP leg `withdraw_to_ata(uint256)`.
export const WITHDRAW_PRECOMPILE_ADDR: Address =
  '0x4200000000000000000000000000000000000016';

/// HelperProgram precompile — hosts the UNWRAP leg `deposit_from_ata(uint256)`.
/// Lowercase (non-checksummed) form — the EIP-55 mixed-case `0xFF…0009`
/// fails viem's address checksum validation in `writeContract` /
/// `signTransaction`; all-lowercase is accepted as-is. Matches
/// interface.sol's `helper_program_address`.
export const HELPER_PRECOMPILE_ADDR: Address =
  '0xff00000000000000000000000000000000000009';

// ─────────────────────────────────────────────────────────────────────
// 4-byte selectors (keccak256(sig)[..4]) — verified, do not trust comments
// ─────────────────────────────────────────────────────────────────────

/// keccak256("withdraw_to_ata(uint256)")[..4]
export const WITHDRAW_TO_ATA_SELECTOR: Hex = '0x8059abc0';

/// keccak256("deposit_from_ata(uint256)")[..4]
export const DEPOSIT_FROM_ATA_SELECTOR: Hex = '0x4479b709';

/// wagmi/viem ABI for the two legs — used by `use-wrap-gas.ts`'s
/// `writeContract({ functionName })` path (mirrors the Rome web app's WRAP_UNWRAP_ABI).
export const WRAP_UNWRAP_ABI = [
  {
    type: 'function',
    name: 'withdraw_to_ata',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'wei_', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'deposit_from_ata',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'wei_', type: 'uint256' }],
    outputs: [],
  },
] as const;

// ─────────────────────────────────────────────────────────────────────
// Decimals
// ─────────────────────────────────────────────────────────────────────

/// Both legs take the amount in **rsol-wei** (18 decimals), not in mint
/// decimals. Internally Rome scales by `10 ^ (RSOL_DECIMALS - mint_decimals)`
/// to land token units. Mirror that constant here so callers convert UI
/// amounts to wei without re-deriving it.
export const RSOL_DECIMALS = 18;

// ─────────────────────────────────────────────────────────────────────
// Encoders — both legs take a single `uint256 wei_` (big-endian, left-padded).
// ─────────────────────────────────────────────────────────────────────

function toU256BeHex(v: bigint): Hex {
  if (v < 0n) throw new Error(`u256 cannot be negative: ${v}`);
  return ('0x' + v.toString(16).padStart(64, '0')) as Hex;
}

/// Encode calldata for the WRAP leg `withdraw_to_ata(uint256 wei_)`.
/// `amountWei` is in 18 decimals (RSOL_DECIMALS).
export function encodeWrapCall(amountWei: bigint): Hex {
  return (WITHDRAW_TO_ATA_SELECTOR + toU256BeHex(amountWei).slice(2)) as Hex;
}

/// Encode calldata for the UNWRAP leg `deposit_from_ata(uint256 wei_)`.
export function encodeUnwrapCall(amountWei: bigint): Hex {
  return (DEPOSIT_FROM_ATA_SELECTOR + toU256BeHex(amountWei).slice(2)) as Hex;
}

/// Convert a UI amount in human units to the rsol-wei amount the
/// precompile expects. Math: amount_wei = amount_human * 10^RSOL_DECIMALS
/// (the precompile downscales by 10^(RSOL_DECIMALS - mint_decimals)).
export function uiAmountToWei(amountHuman: number): bigint {
  if (!Number.isFinite(amountHuman) || amountHuman < 0) {
    throw new Error(`invalid amount: ${amountHuman}`);
  }
  // Pre-scale by 10^9 to keep the float intermediate safe, then multiply
  // the remaining 10^9 in bigint. Past ~9 decimal places rounds down.
  const scaled = BigInt(Math.floor(amountHuman * 1_000_000_000));
  return scaled * 10n ** BigInt(RSOL_DECIMALS - 9);
}

/// Convert a wei amount back to a UI float (lossy for very large values,
/// fine for the < 10^15 range adapter UIs ship).
export function weiToUiAmount(amountWei: bigint): number {
  if (amountWei <= 0n) return 0;
  return Number(amountWei / 10n ** BigInt(RSOL_DECIMALS - 9)) / 1_000_000_000;
}

// ─────────────────────────────────────────────────────────────────────
// Gas estimate (informational copy only — the calls themselves are small).
// ─────────────────────────────────────────────────────────────────────

/// Approximate compute units consumed by a single wrap or unwrap call.
export const CU_WRAP_UNWRAP = 50_000n;
