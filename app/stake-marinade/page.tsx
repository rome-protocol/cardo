// Stake-Marinade route `/stake-marinade` — Marinade Liquid Staking
// `deposit(lamports)` on Solana devnet (Family 4, A1 → A0 promotion via
// the published devnet redeploy of the Marinade program).
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md
//
// One adapter, one LST: mSOL. Deposits land in the user's Rome PDA's
// mSOL ATA. The user's PDA SOL balance (read off Solana devnet) is
// what funds the deposit, NOT the user's Rome EVM balance — same
// model as `/stake` for spl-stake-pool LSTs.

'use client';

import { useCallback, useMemo } from 'react';
import { StakeMarinade } from '@/components/screens/StakeMarinade';
import { useWallet } from '../wallet-context';
import {
  MARINADE_STATE_BS58,
} from '@/lib/marinade-program';
import {
  useMarinadeState,
} from '@/lib/marinade-state';
import { useMarinadeDeposit } from '@/lib/use-marinade-deposit';
import { useStakePoolBalances } from '@/lib/use-stake-pool-balances';
import { useAtaExists } from '@/lib/use-ata-exists';
import { useAtaInit } from '@/lib/use-ata-init';
import { useEnsurePdaLamports } from '@/lib/use-ensure-pda-lamports';

type DepositArgs = { amountSol: number };

export default function Page() {
  const { wallet, connect } = useWallet();
  const view = useMarinadeState(MARINADE_STATE_BS58);
  const { state: depositState, deposit } = useMarinadeDeposit();
  const { state: ataInitState, init: ataInit } = useAtaInit();
  const { ensure: ensureLamports } = useEnsurePdaLamports();

  // Pull mSOL ATA existence + the user's PDA SOL + mSOL balance.
  // We pass the live `msolMint` once it's loaded so the ATA derivation
  // matches the on-chain mint exactly.
  const msolMintHex = view.state?.msolMint;

  const { pdaLamports, lstAmountsByMint } = useStakePoolBalances(
    msolMintHex ? [msolMintHex] : [],
    wallet?.address as `0x${string}` | undefined,
  );

  const ataState = useAtaExists({
    userEvmAddress: wallet?.address as `0x${string}` | undefined,
    mintHex: msolMintHex,
  });

  // Decimal-scaled balances for the screen.
  const solBalance = Number(pdaLamports) / 1_000_000_000;
  const msolBalance = msolMintHex
    ? Number(lstAmountsByMint[msolMintHex] ?? 0n) / 1_000_000_000
    : 0;

  const onSetup = useCallback(async () => {
    if (!wallet?.address) {
      connect?.();
      return;
    }
    if (!msolMintHex) return;
    // The mSOL ATA create + the Marinade deposit both spend SOL from the
    // user's Rome PDA. Fund a reserve first (separate persisting tx — mirrors
    // /stake), then create the ATA. Without this the deposit has no SOL and
    // stalls/reverts — /stake-marinade's setup was missing this funding leg.
    const funded = await ensureLamports(wallet.address as `0x${string}`, {
      minLamports: 50_000_000n,
      reserveLamports: 50_000_000n,
    });
    if (funded !== 'ready') return;
    void ataInit({
      userEvmAddress: wallet.address as `0x${string}`,
      mintHex: msolMintHex,
    });
  }, [wallet?.address, connect, ataInit, msolMintHex, ensureLamports]);

  const onDeposit = useCallback(
    ({ amountSol }: DepositArgs) => {
      if (!wallet?.address) {
        connect?.();
        return;
      }
      const lamports = BigInt(Math.round(amountSol * 1_000_000_000));
      if (lamports <= 0n) return;
      if (!view.state) return;
      void deposit({
        userEvmAddress: wallet.address as `0x${string}`,
        msolMint: view.state.msolMint,
        msolLeg: view.state.msolLeg,
        lamports,
      });
    },
    [wallet?.address, connect, deposit, view.state],
  );

  const ataStatusByMint = useMemo(
    () => (msolMintHex ? { [msolMintHex]: ataState.status } : {}),
    [msolMintHex, ataState.status],
  );

  return (
    <StakeMarinade
      wallet={wallet}
      onConnect={connect}
      view={view}
      solBalance={solBalance}
      msolBalance={msolBalance}
      msolMintHex={msolMintHex}
      ataStatusByMint={ataStatusByMint}
      ataInitState={ataInitState}
      onSetup={onSetup}
      onDeposit={onDeposit}
      depositState={depositState}
    />
  );
}
