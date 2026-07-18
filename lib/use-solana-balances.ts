// useSolanaTokenBalances — read SPL ATA balances directly from Solana
// devnet, bypassing the WWSOL/WUSDC wrapper's user-registration state.
//
// Why this exists: Rome's ERC20-SPL wrappers (WUSDC at 0x6ed2…, WWSOL at
// 0xb7c7…) require each user to call `create_user` on the wrapper before
// the wrapper.balanceOf works. Until then, balanceOf reverts with
// "Token account does not exist". But the user's SPL tokens live in
// their PDA-owned ATA on Solana regardless — the wrapper is just a
// view that needs initialization.
//
// This hook reads the underlying SPL ATAs directly:
//   1. derive user's Rome PDA from EVM address
//      = PDA([EXTERNAL_AUTHORITY, evmAddrBytes], ROME_EVM_PROGRAM)
//   2. derive each token's ATA owned by that PDA
//      = PDA([userPda, TOKEN_PROGRAM, mint], ATA_PROGRAM)
//   3. fetch balance via Solana RPC `getTokenAccountBalance`
//
// Routed through /api/rpc/solana-devnet (same-origin proxy) because
// public Solana RPC's CORS posture isn't wagmi-friendly.
//
// Refetches every 15s. Returns balances keyed by lowercased EVM
// wrapper-address — same shape as `useTokenBalances` so consumers can
// merge or fall through cleanly.

import { useEffect, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import type { Address } from 'viem';
import { romeEvmProgramId } from './solana-pda';

// romeEvmProgramId() is registry-driven (active chain's program, resolved at
// CALL time via the runtime chain) — from solana-pda.ts. It was previously a
// hardcoded const here (retired `DP1dshBz…`), then a module-frozen boot
// default; both derived user PDAs/ATAs under the wrong program on
// non-default chains → funded wallets read 0 and swap/lend forms disabled
// their buttons. (This file is the balance source the swap pages read.)
const SPL_TOKEN_PROGRAM_ID = new PublicKey(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
);
const ASSOC_TOKEN_PROGRAM_ID = new PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
);
const EXTERNAL_AUTHORITY = Buffer.from('EXTERNAL_AUTHORITY');

const REFETCH_MS = 15_000;

export type TokenSPLBalances = Record<string, bigint>;

/** Derive the user's Rome external-authority PDA for an EVM address. */
function deriveRomeUserPda(evmAddress: string): PublicKey {
  if (!/^0x[0-9a-fA-F]{40}$/.test(evmAddress)) {
    throw new Error(`invalid evm address: ${evmAddress}`);
  }
  const userBytes = Buffer.from(evmAddress.slice(2), 'hex');
  const [pda] = PublicKey.findProgramAddressSync(
    [EXTERNAL_AUTHORITY, userBytes],
    romeEvmProgramId(),
  );
  return pda;
}

/** Derive the SPL ATA for a given owner PDA and token mint. */
function deriveAta(owner: PublicKey, mintBase58: string): PublicKey {
  const mint = new PublicKey(mintBase58);
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), SPL_TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOC_TOKEN_PROGRAM_ID,
  );
  return ata;
}

export type SplTokenSpec = {
  /** EVM wrapper address — used as the result key. Lowercased. */
  wrapper: Address;
  /** Base58 SPL mint that the wrapper wraps. */
  mintAddress: string;
};

/**
 * Fetch SPL ATA balances directly from Solana, keyed by the EVM wrapper
 * address (so consumers can drop them into the same map shape as
 * `useTokenBalances`). Returns 0n for ATAs that don't exist yet — that's
 * the truthful answer for an unbridged user.
 */
export function useSolanaTokenBalances(
  tokens: readonly SplTokenSpec[],
  userEvmAddress: Address | undefined,
): TokenSPLBalances {
  const [balances, setBalances] = useState<TokenSPLBalances>({});

  useEffect(() => {
    if (!userEvmAddress || tokens.length === 0) {
      setBalances({});
      return;
    }

    let cancelled = false;
    const userPda = deriveRomeUserPda(userEvmAddress);

    const fetchOnce = async () => {
      // Build per-token ATA list. Skip on derivation errors (malformed
      // mint string) so one bad token doesn't poison the whole batch.
      type Resolved = { wrapperLc: string; ata: string };
      const resolved: Resolved[] = [];
      for (const t of tokens) {
        try {
          const ata = deriveAta(userPda, t.mintAddress).toBase58();
          resolved.push({ wrapperLc: t.wrapper.toLowerCase(), ata });
        } catch {
          // skip
        }
      }
      if (resolved.length === 0) return;

      // Batch via getMultipleAccounts so we issue a single HTTP request
      // for all tokens at once.
      try {
        const res = await fetch('/api/rpc/solana-devnet', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getMultipleAccounts',
            params: [
              resolved.map((r) => r.ata),
              // 'confirmed' — same freshness rationale as the account-existence
              // probes: a just-landed transfer/swap should reflect within one poll.
              { encoding: 'jsonParsed', commitment: 'confirmed' },
            ],
          }),
        });
        const json = await res.json();
        if (cancelled) return;
        const out: TokenSPLBalances = {};
        const values = (json.result?.value ?? []) as Array<
          | {
              data?: { parsed?: { info?: { tokenAmount?: { amount?: string } } } };
            }
          | null
        >;
        resolved.forEach((r, i) => {
          const v = values[i];
          const amt = v?.data?.parsed?.info?.tokenAmount?.amount;
          if (amt && /^\d+$/.test(amt)) {
            out[r.wrapperLc] = BigInt(amt);
          } else {
            // Account doesn't exist or has no SPL data — explicit zero.
            out[r.wrapperLc] = 0n;
          }
        });
        setBalances(out);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[cardo] Solana ATA balance fetch failed', e);
      }
    };

    fetchOnce();
    const id = setInterval(fetchOnce, REFETCH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [
    userEvmAddress,
    // Stringify token list so the effect only re-runs on real changes.
    tokens.map((t) => `${t.wrapper}:${t.mintAddress}`).join('|'),
  ]);

  return balances;
}
