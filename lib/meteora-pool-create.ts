// Meteora DAMM v1 pool creation, encoded for the Rome CPI precompile.
//
// Builds calldata for `dynamic_amm.initialize_permissionless_pool_with_fee_tier`
// — the variant that lets users pick a custom fee tier (bps). The
// pool's PDA derivation depends on whether the fee is the default (25
// bps); a custom value is appended to the pool seed.
//
// **Prerequisite that this hook does NOT enforce on its own:** Meteora
// requires both mints to already have a `dynamic-vault` deployed at
// PDA(["vault", mint, BASE]). On devnet we know vaults exist for the
// canonical Circle USDC + WSOL mints. For arbitrary new mints the
// vault_init must run first (separate flow). The page calls
// `inspectPoolCreate()` to surface a clear "missing vault" error
// before the user signs.
//
// Like swap, submission goes via the CPI precompile: `msg.sender ==
// user EOA` so Rome auto-signs for the user's external-authority PDA,
// which becomes the pool's payer/admin.
//
// Source of truth for account layout & seeds:
//   rome-sdk/rome-meteora/src/dammv1/dynamic-amm/src/instructions/initialize_permissionless_pool.rs
// (look for `InitializePermissionlessPoolWithFeeTier`).

import { PublicKey } from '@solana/web3.js';
import { concat, type Address, type Hex } from 'viem';
import type { AccountMeta } from './cpi-precompile';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
  bytes32ToPublicKey,
  deriveAta,
  deriveRomeUserPda,
  pubkeyBs58ToBytes32,
  pubkeyToBytes32,
} from './solana-pda';
import { METEORA_DAMMV1_PROGRAM } from './meteora-pool';
import { toU64Le } from './meteora-swap';

// ---- Constants ----------------------------------------------------------

/// Anchor discriminators precomputed via sha256("global:<method>")[0..8].
/// See rome-sdk/rome-meteora/src/dammv1/dynamic-amm/src/lib.rs for the
/// canonical method names (`initialize_permissionless_pool_with_fee_tier`).
export const METEORA_INIT_POOL_FEE_TIER_DISC: Hex = '0x06874493e552a971';

/// Meteora dynamic-vault program. Same on devnet/mainnet.
/// bs58: 24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi
export const METEORA_VAULT_PROGRAM_BS58 =
  '24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi';
export const METEORA_VAULT_PROGRAM_ID = new PublicKey(
  METEORA_VAULT_PROGRAM_BS58,
);

/// Hardcoded base address used for vault PDA derivation. From rome-sdk's
/// `dynamic-vault::get_base_address()`.
export const METEORA_VAULT_BASE_BS58 =
  'HWzXGcGHy4tcpYfaRDCyLNzXqBTv3E6BttpCH2vJxArv';
export const METEORA_VAULT_BASE = new PublicKey(METEORA_VAULT_BASE_BS58);

/// Metaplex token-metadata program. Pool init creates an LP metadata account.
export const METAPLEX_METADATA_PROGRAM_BS58 =
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
export const METAPLEX_METADATA_PROGRAM = new PublicKey(
  METAPLEX_METADATA_PROGRAM_BS58,
);

/// System program.
const SYSTEM_PROGRAM_ID = PublicKey.default;

/// Sysvar rent.
const SYSVAR_RENT_BS58 = 'SysvarRent111111111111111111111111111111111';
const SYSVAR_RENT = new PublicKey(SYSVAR_RENT_BS58);

const METEORA_DAMMV1_PROGRAM_ID = bytes32ToPublicKey(METEORA_DAMMV1_PROGRAM);

// Default fee that maps to the empty fee_bps_seed in pool PDA derivation.
// See get_trade_fee_bps_bytes() in initialize_permissionless_pool.rs:
//   default fees: trade_fee_numerator=250, trade_fee_denominator=100000
//   → 25 bps. When the user picks 25 bps the seed is empty; otherwise the
//   8-byte u64 LE encoding is appended.
export const DEFAULT_TRADE_FEE_BPS = 25n;

/// Curve type. ConstantProduct = 0 (Borsh enum discriminator).
export const CURVE_TYPE_CONSTANT_PRODUCT_BYTE = 0;

// ---- PDA derivations ----------------------------------------------------

/// `["lp_mint", pool]` — Meteora DAMM program.
export function deriveDammLpMint(pool: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('lp_mint'), pool.toBuffer()],
    METEORA_DAMMV1_PROGRAM_ID,
  );
  return pda;
}

/// `["vault", mint, BASE]` — Meteora dynamic-vault program.
export function deriveMeteoraVault(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), mint.toBuffer(), METEORA_VAULT_BASE.toBuffer()],
    METEORA_VAULT_PROGRAM_ID,
  );
  return pda;
}

/// `["token_vault", vault]` — Meteora dynamic-vault program.
export function deriveVaultTokenAccount(vault: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('token_vault'), vault.toBuffer()],
    METEORA_VAULT_PROGRAM_ID,
  );
  return pda;
}

/// `["lp_mint", vault]` — Meteora dynamic-vault program.
export function deriveVaultLpMint(vault: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('lp_mint'), vault.toBuffer()],
    METEORA_VAULT_PROGRAM_ID,
  );
  return pda;
}

/// `[vault, pool]` — Meteora DAMM program. The pool's vault-LP holding ATA.
export function deriveVaultLpForPool(
  vault: PublicKey,
  pool: PublicKey,
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [vault.toBuffer(), pool.toBuffer()],
    METEORA_DAMMV1_PROGRAM_ID,
  );
  return pda;
}

/// `["fee", mint, pool]` — Meteora DAMM program.
export function deriveProtocolFeeAta(
  mint: PublicKey,
  pool: PublicKey,
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('fee'), mint.toBuffer(), pool.toBuffer()],
    METEORA_DAMMV1_PROGRAM_ID,
  );
  return pda;
}

/// `["metadata", mpl_program, lp_mint]` — Metaplex token-metadata program.
export function deriveLpMintMetadata(lpMint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from('metadata'),
      METAPLEX_METADATA_PROGRAM.toBuffer(),
      lpMint.toBuffer(),
    ],
    METAPLEX_METADATA_PROGRAM,
  );
  return pda;
}

/// Pool PDA. Seeds depend on whether the fee tier is the default 25 bps:
///   default → [curve_type, first, second]
///   custom  → [curve_type, first, second, u64le(trade_fee_bps)]
/// where first = max(mintA, mintB), second = min(mintA, mintB).
export function deriveDammPool(
  mintA: PublicKey,
  mintB: PublicKey,
  tradeFeeBps: bigint,
): PublicKey {
  const a = mintA.toBuffer();
  const b = mintB.toBuffer();
  // Compare lexicographically — `Buffer.compare` returns -1/0/+1.
  const cmp = a.compare(b);
  const first = cmp > 0 ? a : b;
  const second = cmp > 0 ? b : a;
  const seeds: Buffer[] = [
    Buffer.from([CURVE_TYPE_CONSTANT_PRODUCT_BYTE]),
    first,
    second,
  ];
  if (tradeFeeBps !== DEFAULT_TRADE_FEE_BPS) {
    // u64 LE encoding of the bps value.
    const bps = Buffer.alloc(8);
    bps.writeBigUInt64LE(tradeFeeBps);
    seeds.push(bps);
  }
  const [pda] = PublicKey.findProgramAddressSync(
    seeds,
    METEORA_DAMMV1_PROGRAM_ID,
  );
  return pda;
}

// ---- Whole-flow resolver ------------------------------------------------

export type PoolCreateAddresses = {
  /// First key = max(mintA, mintB) — Meteora's "A" assignment may differ
  /// from caller's input order. We re-emit the canonical assignment here.
  /// All subsequent fields use it.
  resolvedMintA: PublicKey; // first (lexicographically larger)
  resolvedMintB: PublicKey; // second (smaller)
  pool: PublicKey;
  lpMint: PublicKey;
  aVault: PublicKey;
  bVault: PublicKey;
  aTokenVault: PublicKey;
  bTokenVault: PublicKey;
  aVaultLpMint: PublicKey;
  bVaultLpMint: PublicKey;
  aVaultLp: PublicKey;
  bVaultLp: PublicKey;
  payerTokenA: PublicKey; // user's ATA for resolvedMintA
  payerTokenB: PublicKey; // user's ATA for resolvedMintB
  payerPoolLp: PublicKey; // user's ATA for the new lp mint
  protocolTokenAFee: PublicKey;
  protocolTokenBFee: PublicKey;
  payer: PublicKey; // user's Rome PDA (also acts as fee_owner per CHECK)
  feeOwner: PublicKey; // a_vault_lp (per Meteora's contract comment)
  mintMetadata: PublicKey;
};

/// Optional per-mint override for the existing vault's `token_vault` and
/// `lp_mint`. These are normally PDA-derivable, but legacy vaults (Rome
/// devnet's WSOL is one) store a non-PDA `lp_mint`. Callers should fetch
/// `useMeteoraVaultStates` and pass the actual on-chain values here.
/// Keys are mint hex (lowercased).
export type VaultStateOverrides = Record<
  string,
  { tokenVault: Hex; lpMint: Hex } | undefined
>;

/**
 * Resolve every PDA + ATA needed for the pool init instruction. Pure
 * client-side derivation — no network reads, no on-chain checks. Note
 * that the user-facing inputs (mintAHex/mintBHex) are *not* reordered
 * — the caller's choice of A/B is preserved. Meteora's pool PDA seed
 * sorts internally so the seed itself is still order-independent.
 *
 * Throws if `mintAHex === mintBHex` (Meteora MismatchedTokenMint).
 */
export function derivePoolCreateAddresses(args: {
  userEvmAddress: Address;
  mintAHex: Hex;
  mintBHex: Hex;
  tradeFeeBps: bigint;
  /// Optional overrides for legacy/non-PDA vault state. Keys are mint
  /// hex (lowercased).
  vaultOverrides?: VaultStateOverrides;
}): PoolCreateAddresses {
  const mintA = bytes32ToPublicKey(args.mintAHex);
  const mintB = bytes32ToPublicKey(args.mintBHex);
  if (mintA.equals(mintB)) {
    throw new Error('mintA must differ from mintB');
  }

  // Per Meteora: the pool PDA seed sorts (max, min) internally, but the
  // pool's stored `token_a_mint`/`token_b_mint` come from the caller's
  // input order. We keep caller's A/B labeling.
  const resolvedMintA = mintA;
  const resolvedMintB = mintB;

  const pool = deriveDammPool(resolvedMintA, resolvedMintB, args.tradeFeeBps);
  const lpMint = deriveDammLpMint(pool);
  const aVault = deriveMeteoraVault(resolvedMintA);
  const bVault = deriveMeteoraVault(resolvedMintB);

  // Token vault + vault LP mint may be overridden when the on-chain
  // vault state diverges from PDA derivation (legacy vault paths).
  const aOver = args.vaultOverrides?.[args.mintAHex.toLowerCase()];
  const bOver = args.vaultOverrides?.[args.mintBHex.toLowerCase()];
  const aTokenVault = aOver
    ? bytes32ToPublicKey(aOver.tokenVault)
    : deriveVaultTokenAccount(aVault);
  const bTokenVault = bOver
    ? bytes32ToPublicKey(bOver.tokenVault)
    : deriveVaultTokenAccount(bVault);
  const aVaultLpMint = aOver
    ? bytes32ToPublicKey(aOver.lpMint)
    : deriveVaultLpMint(aVault);
  const bVaultLpMint = bOver
    ? bytes32ToPublicKey(bOver.lpMint)
    : deriveVaultLpMint(bVault);
  const aVaultLp = deriveVaultLpForPool(aVault, pool);
  const bVaultLp = deriveVaultLpForPool(bVault, pool);

  const userPda = bytes32ToPublicKey(deriveRomeUserPda(args.userEvmAddress));
  const payerTokenA = bytes32ToPublicKey(
    deriveAta(pubkeyToBytes32(userPda), pubkeyToBytes32(resolvedMintA)),
  );
  const payerTokenB = bytes32ToPublicKey(
    deriveAta(pubkeyToBytes32(userPda), pubkeyToBytes32(resolvedMintB)),
  );
  // payer_pool_lp uses Anchor's associated_token::authority = payer macro.
  // The "payer" for that constraint is the signer (payer field below) =
  // the user's Rome PDA. So its ATA is also derived against userPda.
  const payerPoolLp = bytes32ToPublicKey(
    deriveAta(pubkeyToBytes32(userPda), pubkeyToBytes32(lpMint)),
  );

  const protocolTokenAFee = deriveProtocolFeeAta(resolvedMintA, pool);
  const protocolTokenBFee = deriveProtocolFeeAta(resolvedMintB, pool);

  const mintMetadata = deriveLpMintMetadata(lpMint);

  return {
    resolvedMintA,
    resolvedMintB,
    pool,
    lpMint,
    aVault,
    bVault,
    aTokenVault,
    bTokenVault,
    aVaultLpMint,
    bVaultLpMint,
    aVaultLp,
    bVaultLp,
    payerTokenA,
    payerTokenB,
    payerPoolLp,
    protocolTokenAFee,
    protocolTokenBFee,
    payer: userPda,
    // Per the Meteora contract comment `/// CHECK: fee owner will be
    // a_vault_lp` — the on-chain code hard-codes the fee_owner to a_vault_lp
    // regardless of what's passed, but the account-meta entry must point at
    // the right pubkey to satisfy account-info loads.
    feeOwner: aVaultLp,
    mintMetadata,
  };
}

// ---- Calldata + AccountMeta builder -------------------------------------

/// Encode the instruction data for `initialize_permissionless_pool_with_fee_tier`.
///
/// data = disc(8) || curve_type(1) || u64le(trade_fee_bps) || u64le(token_a_amount) || u64le(token_b_amount)
export function encodePoolInitData(args: {
  tradeFeeBps: bigint;
  tokenAAmount: bigint; // raw units of resolvedMintA
  tokenBAmount: bigint; // raw units of resolvedMintB
}): Hex {
  return concat([
    METEORA_INIT_POOL_FEE_TIER_DISC,
    ('0x' + CURVE_TYPE_CONSTANT_PRODUCT_BYTE.toString(16).padStart(2, '0')) as Hex,
    toU64Le(args.tradeFeeBps),
    toU64Le(args.tokenAAmount),
    toU64Le(args.tokenBAmount),
  ]);
}

/// Build the 26-account-meta list. Order + flags must match the Anchor
/// IDL field order of `InitializePermissionlessPoolWithFeeTier`.
export function buildPoolInitAccountMetas(addrs: PoolCreateAddresses): AccountMeta[] {
  const pk = (k: PublicKey) => pubkeyToBytes32(k);
  return [
    // [ 0] pool — init, w
    { pubkey: pk(addrs.pool), is_signer: false, is_writable: true },
    // [ 1] lp_mint — init, w
    { pubkey: pk(addrs.lpMint), is_signer: false, is_writable: true },
    // [ 2] token_a_mint — r
    { pubkey: pk(addrs.resolvedMintA), is_signer: false, is_writable: false },
    // [ 3] token_b_mint — r
    { pubkey: pk(addrs.resolvedMintB), is_signer: false, is_writable: false },
    // [ 4] a_vault — w
    { pubkey: pk(addrs.aVault), is_signer: false, is_writable: true },
    // [ 5] b_vault — w
    { pubkey: pk(addrs.bVault), is_signer: false, is_writable: true },
    // [ 6] a_token_vault — w
    { pubkey: pk(addrs.aTokenVault), is_signer: false, is_writable: true },
    // [ 7] b_token_vault — w
    { pubkey: pk(addrs.bTokenVault), is_signer: false, is_writable: true },
    // [ 8] a_vault_lp_mint — w
    { pubkey: pk(addrs.aVaultLpMint), is_signer: false, is_writable: true },
    // [ 9] b_vault_lp_mint — w
    { pubkey: pk(addrs.bVaultLpMint), is_signer: false, is_writable: true },
    // [10] a_vault_lp — init, w
    { pubkey: pk(addrs.aVaultLp), is_signer: false, is_writable: true },
    // [11] b_vault_lp — init, w
    { pubkey: pk(addrs.bVaultLp), is_signer: false, is_writable: true },
    // [12] payer_token_a — w
    { pubkey: pk(addrs.payerTokenA), is_signer: false, is_writable: true },
    // [13] payer_token_b — w
    { pubkey: pk(addrs.payerTokenB), is_signer: false, is_writable: true },
    // [14] payer_pool_lp — init, w
    { pubkey: pk(addrs.payerPoolLp), is_signer: false, is_writable: true },
    // [15] protocol_token_a_fee — init, w
    { pubkey: pk(addrs.protocolTokenAFee), is_signer: false, is_writable: true },
    // [16] protocol_token_b_fee — init, w
    { pubkey: pk(addrs.protocolTokenBFee), is_signer: false, is_writable: true },
    // [17] payer — signer, w (Rome auto-signs for the user's PDA)
    { pubkey: pk(addrs.payer), is_signer: true, is_writable: true },
    // [18] fee_owner — r
    { pubkey: pk(addrs.feeOwner), is_signer: false, is_writable: false },
    // [19] rent — sysvar
    { pubkey: pk(SYSVAR_RENT), is_signer: false, is_writable: false },
    // [20] mint_metadata — w
    { pubkey: pk(addrs.mintMetadata), is_signer: false, is_writable: true },
    // [21] metadata_program — r
    { pubkey: pk(METAPLEX_METADATA_PROGRAM), is_signer: false, is_writable: false },
    // [22] vault_program — r
    { pubkey: pk(METEORA_VAULT_PROGRAM_ID), is_signer: false, is_writable: false },
    // [23] token_program — r
    { pubkey: pk(SPL_TOKEN_PROGRAM_ID), is_signer: false, is_writable: false },
    // [24] associated_token_program — r
    { pubkey: pk(ASSOCIATED_TOKEN_PROGRAM_ID), is_signer: false, is_writable: false },
    // [25] system_program — r
    { pubkey: pk(SYSTEM_PROGRAM_ID), is_signer: false, is_writable: false },
  ];
}

export type PoolCreateInvoke = {
  program: Hex;
  accounts: AccountMeta[];
  data: Hex;
  /// Echo of the resolved addresses, so the caller can render them in
  /// the preview before signing.
  addresses: PoolCreateAddresses;
};

/**
 * Compose the full `invoke(program, accounts, data)` payload for the CPI
 * precompile. Caller signs and submits with wagmi.writeContract.
 */
export function buildChainMeteoraPoolInitInvoke(args: {
  userEvmAddress: Address;
  mintAHex: Hex;
  mintBHex: Hex;
  tradeFeeBps: bigint;
  tokenAAmount: bigint;
  tokenBAmount: bigint;
  vaultOverrides?: VaultStateOverrides;
}): PoolCreateInvoke {
  const addresses = derivePoolCreateAddresses({
    userEvmAddress: args.userEvmAddress,
    mintAHex: args.mintAHex,
    mintBHex: args.mintBHex,
    tradeFeeBps: args.tradeFeeBps,
    vaultOverrides: args.vaultOverrides,
  });
  const accounts = buildPoolInitAccountMetas(addresses);
  const data = encodePoolInitData({
    tradeFeeBps: args.tradeFeeBps,
    tokenAAmount: args.tokenAAmount,
    tokenBAmount: args.tokenBAmount,
  });
  return { program: METEORA_DAMMV1_PROGRAM, accounts, data, addresses };
}

// Re-export for callers.
export { pubkeyBs58ToBytes32 };
