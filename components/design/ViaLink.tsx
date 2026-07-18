'use client';
// ViaLink — a settled transaction's link to the Rome Via explorer. Registry-
// driven URL (lib/chain-config explorerTxUrl), so it follows the active chain.
// Renders nothing without a hash. Styled by the actsee `.status a` rule (gold,
// underlined) wherever it sits inside a status line.

import { explorerTxUrl } from '../../lib/chain-config';

export function ViaLink({ hash, label }: { hash?: string; label?: string }) {
  if (!hash) return null;
  const short = label ?? `${hash.slice(0, 6)}…${hash.slice(-4)}`;
  return (
    <a href={explorerTxUrl(hash)} target="_blank" rel="noreferrer" title={hash}>
      {short} ↗
    </a>
  );
}
