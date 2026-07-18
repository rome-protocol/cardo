// useMeteoraVaultStates — read each mint's Meteora dynamic-vault state and
// extract the (vault, tokenVault, lpMint) triple needed for pool init.
//
// Why this exists: vault `lp_mint` and `token_vault` are stored on the
// vault account itself, not always at PDA-deterministic addresses.
// Devnet's WSOL vault has a non-PDA lp_mint (legacy artifact) — so
// deriving via `["lp_mint", vault]` works for USDC vault but not WSOL.
// Reading from chain is the only robust path.
//
// Vault state Borsh layout (from rome-sdk/rome-meteora dynamic-vault state.rs):
//   [ 0..8  ] account discriminator
//   [ 8     ] enabled (u8)
//   [ 9     ] vault_bump (u8)
//   [10     ] token_vault_bump (u8)
//   [11..19 ] total_amount (u64 LE)
//   [19..51 ] token_vault (Pubkey)
//   [51..83 ] fee_vault (Pubkey)
//   [83..115] token_mint (Pubkey)
//   [115..147] lp_mint (Pubkey)

import { useEffect, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import type { Hex } from 'viem';
import {
  deriveMeteoraVault,
  METEORA_VAULT_PROGRAM_ID,
} from './meteora-pool-create';
import { bytes32ToPublicKey, pubkeyToBytes32 } from './solana-pda';

export type VaultStateInfo = {
  vault: PublicKey;
  tokenVault: PublicKey;
  lpMint: PublicKey;
  vaultBytes32: Hex;
  tokenVaultBytes32: Hex;
  lpMintBytes32: Hex;
};

export type VaultStatesMap = Record<string, VaultStateInfo | null>; // null = vault missing

const TOKEN_VAULT_OFFSET = 19;
const LP_MINT_OFFSET = 115;
const PUBKEY_LEN = 32;

/// Polls vault state every `refreshMs` so newly-initialized vaults
/// land in the picker without a manual reload. 8s is fast enough that
/// users see &quot;✓ exists&quot; within a few seconds of the init tx confirming
/// without flooding the proxy.
const REFRESH_MS = 8_000;

export function useMeteoraVaultStates(
  mintHexList: readonly Hex[],
): { byMint: VaultStatesMap; loading: boolean; refresh: () => void } {
  const [byMint, setByMint] = useState<VaultStatesMap>({});
  const [loading, setLoading] = useState(false);
  // Bump-counter trigger so callers can force an immediate re-fetch
  // (e.g. right after vault.initialize confirms) without waiting for
  // the next poll tick.
  const [tick, setTick] = useState(0);
  const refresh = () => setTick((t) => t + 1);

  useEffect(() => {
    if (mintHexList.length === 0) {
      setByMint({});
      return;
    }
    let cancelled = false;
    setLoading(true);

    const tick = async () => {
      try {
        const items = mintHexList.map((mintHex) => {
          const mint = bytes32ToPublicKey(mintHex);
          return {
            mintHexLc: mintHex.toLowerCase(),
            mint,
            vault: deriveMeteoraVault(mint),
          };
        });
        const res = await fetch('/api/rpc/solana-devnet', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getMultipleAccounts',
            params: [
              items.map((i) => i.vault.toBase58()),
              { encoding: 'base64' },
            ],
          }),
        });
        const json = await res.json();
        if (cancelled) return;
        const values = (json.result?.value ?? []) as Array<
          { owner?: string; data?: [string, string] } | null
        >;
        const out: VaultStatesMap = {};
        items.forEach((it, i) => {
          const acc = values[i];
          if (!acc || acc.owner !== METEORA_VAULT_PROGRAM_ID.toBase58()) {
            out[it.mintHexLc] = null;
            return;
          }
          if (!acc.data || !acc.data[0]) {
            out[it.mintHexLc] = null;
            return;
          }
          const data = Buffer.from(acc.data[0], 'base64');
          if (data.length < LP_MINT_OFFSET + PUBKEY_LEN) {
            out[it.mintHexLc] = null;
            return;
          }
          const tokenVaultBytes = data.subarray(
            TOKEN_VAULT_OFFSET,
            TOKEN_VAULT_OFFSET + PUBKEY_LEN,
          );
          const lpMintBytes = data.subarray(
            LP_MINT_OFFSET,
            LP_MINT_OFFSET + PUBKEY_LEN,
          );
          const tokenVault = new PublicKey(tokenVaultBytes);
          const lpMint = new PublicKey(lpMintBytes);
          out[it.mintHexLc] = {
            vault: it.vault,
            tokenVault,
            lpMint,
            vaultBytes32: pubkeyToBytes32(it.vault),
            tokenVaultBytes32: pubkeyToBytes32(tokenVault),
            lpMintBytes32: pubkeyToBytes32(lpMint),
          };
        });
        setByMint(out);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[cardo pool-create] vault state fetch failed', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    tick();
    const id = setInterval(tick, REFRESH_MS);

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [mintHexList.map((m) => m.toLowerCase()).join('|'), tick]); // eslint-disable-line react-hooks/exhaustive-deps

  return { byMint, loading, refresh };
}
