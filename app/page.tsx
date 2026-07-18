// Home route `/` — the act|see Portfolio dashboard. Threads the router + shared
// wallet state into the screen and feeds it live holdings via useHoldings
// (the same balance plumbing /swap uses). Rendered inside the dark DesignShell
// (see app/Shell.tsx REDESIGNED set).

'use client';

import { useRouter } from 'next/navigation';
import type { Address } from 'viem';
import { Home } from '@/components/screens/Home';
import { useWallet } from './wallet-context';
import { useHoldings } from '@/lib/use-holdings';

export default function Page() {
  const router = useRouter();
  const { wallet, connect } = useWallet();
  const userEvm =
    wallet.connected && wallet.address ? (wallet.address as Address) : undefined;
  const { holdings, totalUsd, loading } = useHoldings(userEvm);
  return (
    <Home
      onNav={(to: string) => router.push(to)}
      wallet={wallet}
      onConnect={connect}
      holdings={holdings}
      totalUsd={totalUsd}
      loading={loading}
    />
  );
}
