// Parametrized funded swap-venue table. Every venue renders the SAME act|see
// Swap rig (getByLabel('Pay amount') + button[type=submit] + settled-tx
// ViaLink), so ONE spec (swap-venues.funded.spec.ts) drives them all via the
// reusable landFundedTx harness — no per-venue copy. Adding a venue = one row.
//
// Direction note: every venue page defaults to wSOL→wUSDC (the canonical devnet
// pair), so the treasury must hold the input wrapper (wSOL / wWSOL). /swap keeps
// its own spec — it defaults the OTHER way (wUSDC→wSOL) and is already proven,
// and a wUSDC→wSOL swap is in fact how the treasury ACQUIRES the wSOL these
// venue swaps spend.

export type SwapVenue = {
  /** act|see route path. */
  route: string;
  /** Human label for the test title. */
  venue: string;
  /** UI 'Pay amount' value (kept small — wSOL is scarce on the treasury). */
  payAmount: string;
  /** Symbol the treasury must hold for the CTA to enable (drives skip hint). */
  inputToken: string;
};

// Clean default-pair venues: load the page, fill 'Pay amount', submit (default
// wSOL→wUSDC pair). Every act|see swap screen exposes aria-label="Pay amount";
// landFundedTx skips-with-reason (not fails) when a seeded pool is in a
// swap-disabled state, so the suite stays green while flagging the blocker.
// NOTE: /swap-orca is intentionally NOT here — it's a legacy (un-migrated,
// light-design) route; /orca is the act|see Orca surface and covers the venue.
export const SWAP_VENUES: SwapVenue[] = [
  { route: '/orca', venue: 'Orca Whirlpool', payAmount: '0.001', inputToken: 'wSOL' },
  { route: '/swap-dlmm', venue: 'Meteora DLMM', payAmount: '0.001', inputToken: 'wSOL' },
  { route: '/swap-meteora-v2', venue: 'Meteora DAMM v2', payAmount: '0.001', inputToken: 'wSOL' },
  { route: '/swap-phoenix', venue: 'Phoenix CLOB', payAmount: '0.001', inputToken: 'wSOL' },
  { route: '/swap-raydium', venue: 'Raydium CPMM', payAmount: '0.001', inputToken: 'wSOL' },
  { route: '/swap-raydium-amm', venue: 'Raydium AMM v4', payAmount: '0.001', inputToken: 'wSOL' },
  // /swap-raydium-clmm is intentionally NOT here: the seeded devnet CLMM pool
  // (HXAQnU2…) has one-sided liquidity — USDC→WSOL fills but the default
  // WSOL→USDC reverts Custom(6019) (no liquidity below the current tick). The
  // builder is correct (the up-direction works); re-add once the pool is
  // re-seeded with two-sided liquidity. Tracked as an infra item.
];

// Memecoin venues (/swap-pumpswap, /swap-pumpfun) are NOT clean default-pair
// swaps: the form sits behind a WrapperGate on the memecoin base mint, so the
// 'Pay amount' field only renders after the MEME wrapper is initialized (and a
// buy needs the quote wrapper funded). They need a custom fill (wrapper-init +
// memecoin selection) — tracked as a separate follow-up, not in this table.
