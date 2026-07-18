// useUserDeployedTokens — local persistence of tokens the user has
// just deployed via /pool/new's "Deploy new token" flow. Survives page
// reloads (localStorage) so the new token keeps appearing in the
// picker until the static list or factory enumeration catches up.
//
// Schema (versioned key in case the shape changes later):
//   localStorage['cardo:user-deployed-tokens:v1'] = JSON of ChainToken[]
//
// All entries default to swappable=false because newly-deployed tokens
// have no Meteora pool yet.

import { useCallback, useEffect, useState } from 'react';
import type { ChainToken } from '@/lib/use-chain-tokens';

const STORAGE_KEY = 'cardo:user-deployed-tokens:v1';

function readStorage(): ChainToken[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t): t is ChainToken =>
      typeof t === 'object' &&
      t !== null &&
      typeof t.address === 'string' &&
      typeof t.symbol === 'string' &&
      typeof t.decimals === 'number' &&
      typeof t.mintAddress === 'string',
    );
  } catch {
    return [];
  }
}

function writeStorage(tokens: ChainToken[]) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(tokens));
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[cardo] failed to persist user-deployed tokens', e);
  }
}

export function useUserDeployedTokens(): {
  tokens: ChainToken[];
  add: (t: ChainToken) => void;
  clear: () => void;
} {
  const [tokens, setTokens] = useState<ChainToken[]>([]);

  useEffect(() => {
    setTokens(readStorage());
  }, []);

  const add = useCallback((t: ChainToken) => {
    setTokens((prev) => {
      // dedupe by lowercased address
      const lc = t.address.toLowerCase();
      const filtered = prev.filter((p) => p.address.toLowerCase() !== lc);
      const next = [...filtered, t];
      writeStorage(next);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setTokens([]);
    writeStorage([]);
  }, []);

  return { tokens, add, clear };
}
